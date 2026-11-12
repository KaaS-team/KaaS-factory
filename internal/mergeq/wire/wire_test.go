package wire_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/gitx"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/mergeq/wire"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
	gogithub "github.com/google/go-github/v79/github"
)

// Each adapter satisfies the mergeq interface it stands in for.
var (
	_ mergeq.Git     = wire.Git{}
	_ mergeq.Gate    = wire.Gate{}
	_ mergeq.Heads   = wire.Heads{}
	_ mergeq.Tracker = (*gh.Tracker)(nil)
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// fakeHub is a stateful fake of the GitHub endpoints the queue touches.
type fakeHub struct {
	mu       sync.Mutex
	heads    map[int]string // PR number to head sha
	labels   map[int]string // issue to its one lifecycle label
	comments map[int][]string
}

func (f *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	enc := json.NewEncoder(w)
	p := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // repos o r ...
	if len(p) < 4 || p[0] != "repos" {
		http.Error(w, "{}", http.StatusTeapot)
		return
	}
	var n int
	if len(p) > 4 {
		_, _ = fmt.Sscan(p[4], &n)
	}
	switch {
	case r.Method == "GET" && p[3] == "issues" && len(p) == 4:
		label := r.URL.Query().Get("labels")
		var out []map[string]any
		for _, i := range []int{1, 2} {
			if f.labels[i] == label {
				out = append(out, map[string]any{"number": i, "labels": []map[string]any{{"name": label}}})
			}
		}
		_ = enc.Encode(out)
	case r.Method == "GET" && p[3] == "issues" && len(p) == 6 && p[5] == "comments":
		var out []map[string]any
		for i, b := range f.comments[n] {
			out = append(out, map[string]any{"body": b, "created_at": fmt.Sprintf("2024-03-0%dT00:00:00Z", n+i)})
		}
		_ = enc.Encode(out)
	case r.Method == "POST" && p[3] == "issues" && len(p) == 6 && p[5] == "comments":
		var b struct{ Body string }
		_ = json.NewDecoder(r.Body).Decode(&b)
		f.comments[n] = append(f.comments[n], b.Body)
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("{}"))
	case r.Method == "GET" && p[3] == "issues" && len(p) == 5:
		_ = enc.Encode(map[string]any{"number": n, "labels": []map[string]any{{"name": f.labels[n]}}})
	case r.Method == "DELETE" && p[3] == "issues" && len(p) == 7 && p[5] == "labels":
		f.labels[n] = ""
		_, _ = w.Write([]byte("[]"))
	case r.Method == "POST" && p[3] == "issues" && len(p) == 6 && p[5] == "labels":
		var l []string
		_ = json.NewDecoder(r.Body).Decode(&l)
		f.labels[n] = l[0]
		_, _ = w.Write([]byte("[]"))
	case r.Method == "GET" && p[3] == "pulls" && len(p) == 5:
		_ = enc.Encode(map[string]any{"number": n, "state": "open", "head": map[string]any{"sha": f.heads[n]}})
	default:
		http.Error(w, fmt.Sprintf(`{"message":"unrouted %s %s"}`, r.Method, r.URL.Path), http.StatusTeapot)
	}
}

// The whole queue over real git and a real gate process: the green PR lands on the remote base,
// the red one is ejected with the gate log in a steer comment.
func TestRunLandsGreenAndEjectsRed(t *testing.T) {
	root := t.TempDir()
	remote := filepath.Join(root, "remote.git")
	seed := filepath.Join(root, "seed")
	clone := filepath.Join(root, "clone")
	git(t, root, "init", "-q", "--bare", "remote.git")
	git(t, root, "clone", "-q", "remote.git", "seed")
	write := func(dir, name, body string) {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(seed, "base.txt", "base\n")
	git(t, seed, "add", ".")
	git(t, seed, "commit", "-qm", "base")
	git(t, seed, "push", "-q", "origin", "HEAD:refs/heads/main")
	var heads = map[int]string{}
	for pr, file := range map[int]string{11: "green.txt", 12: "red.txt"} {
		git(t, seed, "checkout", "-q", "-b", "b"+file, "origin/main")
		write(seed, file, file+"\n")
		git(t, seed, "add", ".")
		git(t, seed, "commit", "-qm", file)
		git(t, seed, "push", "-q", "origin", "HEAD:refs/heads/b"+file)
		heads[pr] = git(t, seed, "rev-parse", "HEAD")
	}
	git(t, root, "clone", "-q", "remote.git", "clone")

	// The gate script is found on PATH; it is red when red.txt is in the tree it runs on.
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	write(bin, "gates.sh", `#!/bin/sh
if [ -f red.txt ]; then
  echo "FAIL red.txt must not exist"
  echo "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=redcheck"
  exit 1
fi
echo "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-"
`)
	if err := os.Chmod(filepath.Join(bin, "gates.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	marker := func(pr int) string {
		return fmt.Sprintf("Queued for merge as PR #%d.\n\n<!-- factory:queued {\"pr\":%d,\"head\":%q} -->", pr, pr, heads[pr])
	}
	hub := &fakeHub{
		heads:    heads,
		labels:   map[int]string{1: gh.LabelInReview, 2: gh.LabelInReview},
		comments: map[int][]string{1: {marker(11)}, 2: {marker(12)}},
	}
	srv := httptest.NewServer(hub)
	t.Cleanup(srv.Close)

	tr, err := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: srv.URL + "/", HTTPClient: srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	client := gogithub.NewClient(srv.Client())
	client.BaseURL, _ = url.Parse(srv.URL + "/")
	q, err := wire.New(tr, clone, mergeq.Config{}, client, "o", "r")
	if err != nil {
		t.Fatal(err)
	}

	rep, err := q.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Landed) != 1 || rep.Landed[0] != "1" {
		t.Fatalf("landed = %v, want [1]", rep.Landed)
	}
	if len(rep.Ejected) != 1 || rep.Ejected[0].ID != "2" || !strings.Contains(rep.Ejected[0].LogTail, "red.txt must not exist") {
		t.Fatalf("ejected = %+v, want issue 2 with the gate log", rep.Ejected)
	}

	// The remote base now holds the green PR's commit and not the red one's.
	tip := git(t, root, "--git-dir="+remote, "rev-parse", "main")
	if out := git(t, root, "--git-dir="+remote, "ls-tree", "--name-only", tip); !strings.Contains(out, "green.txt") || strings.Contains(out, "red.txt") {
		t.Fatalf("remote main tree:\n%s", out)
	}
	if got, want := hub.labels[1], ""; got != want {
		t.Fatalf("issue 1 label = %q, want none (merged)", got)
	}
	if got := hub.labels[2]; got != gh.LabelNeedsHuman {
		t.Fatalf("issue 2 label = %q, want %s", got, gh.LabelNeedsHuman)
	}
	steer := hub.comments[2][len(hub.comments[2])-1]
	if !strings.Contains(steer, "Needs a human") || !strings.Contains(steer, "FAIL red.txt must not exist") {
		t.Fatalf("steer comment lacks the gate log:\n%s", steer)
	}
}

func TestNewRejectsBadArguments(t *testing.T) {
	tr, _ := gh.New(gh.Config{Owner: "o", Repo: "r"})
	c := gogithub.NewClient(nil)
	dir := t.TempDir()
	for name, call := range map[string]func() error{
		"nil tracker": func() error { _, err := wire.New(nil, dir, mergeq.Config{}, c, "o", "r"); return err },
		"nil client":  func() error { _, err := wire.New(tr, dir, mergeq.Config{}, nil, "o", "r"); return err },
		"no owner":    func() error { _, err := wire.New(tr, dir, mergeq.Config{}, c, "", "r"); return err },
		"no dir":      func() error { _, err := wire.New(tr, dir+"/missing", mergeq.Config{}, c, "o", "r"); return err },
	} {
		if call() == nil {
			t.Errorf("%s: want an error", name)
		}
	}
}

// A head that conflicts with the base comes back as mergeq.ErrConflict, and a base that moved
// after the merge makes FastForward return mergeq.ErrBaseMoved.
func TestGitConflictAndBaseMoved(t *testing.T) {
	root := t.TempDir()
	git(t, root, "init", "-q", "--bare", "remote.git")
	git(t, root, "clone", "-q", "remote.git", "w")
	w := filepath.Join(root, "w")
	commit := func(branch, body string) string {
		git(t, w, "checkout", "-q", "-B", branch, "origin/main")
		_ = os.WriteFile(filepath.Join(w, "f.txt"), []byte(body), 0o644)
		git(t, w, "add", ".")
		git(t, w, "commit", "-qm", body)
		return git(t, w, "rev-parse", "HEAD")
	}
	_ = os.WriteFile(filepath.Join(w, "f.txt"), []byte("0\n"), 0o644)
	git(t, w, "add", ".")
	git(t, w, "commit", "-qm", "0")
	git(t, w, "push", "-q", "origin", "HEAD:refs/heads/main")
	git(t, w, "fetch", "-q")
	a, b := commit("a", "a\n"), commit("b", "b\n")
	git(t, w, "push", "-q", "origin", "a", "b")
	g := wire.Git{G: gitx.New(w)}
	ctx := context.Background()

	m, err := g.Merge(ctx, []string{a})
	if err != nil {
		t.Fatal(err)
	}
	// Move the remote base after the merge was made: the push is no longer a fast-forward.
	git(t, w, "push", "-q", "origin", b+":refs/heads/main")
	if err := g.FastForward(ctx, m.Ref); !errors.Is(err, mergeq.ErrBaseMoved) {
		t.Fatalf("FastForward after the base moved = %v, want ErrBaseMoved", err)
	}
	// Now a (based on the old main) conflicts with b, which is the base.
	if _, err := g.Merge(ctx, []string{a}); !errors.Is(err, mergeq.ErrConflict) {
		t.Fatalf("Merge of a conflicting head = %v, want ErrConflict", err)
	}
}
