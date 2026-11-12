package gitx_test

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/gitx"
)

// run executes git in dir and fails the test on error.
func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// newRepo returns a repo with main holding a.txt and b.txt.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	run(t, dir, "init", "-q", "-b", "main")
	write(t, dir, "a.txt", "one\ntwo\nthree\n")
	write(t, dir, "b.txt", "x\ny\nz\n")
	run(t, dir, "add", ".")
	run(t, dir, "commit", "-q", "-m", "base")
	return dir
}

func branch(t *testing.T, dir, name string, edits map[string]string) {
	t.Helper()
	run(t, dir, "checkout", "-q", "-b", name, "main")
	for f, c := range edits {
		write(t, dir, f, c)
	}
	run(t, dir, "commit", "-q", "-am", name)
	run(t, dir, "checkout", "-q", "main")
}

func TestMergeTree(t *testing.T) {
	cases := []struct {
		name string
		a, b map[string]string
		want []string
	}{
		{"same line, same file", map[string]string{"a.txt": "one\nTWO-A\nthree\n"}, map[string]string{"a.txt": "one\nTWO-B\nthree\n"}, []string{"a.txt"}},
		{"different files", map[string]string{"a.txt": "one\nTWO-A\nthree\n"}, map[string]string{"b.txt": "x\nY\nz\n"}, nil},
		{"same file, different lines", map[string]string{"a.txt": "ONE\ntwo\nthree\n"}, map[string]string{"a.txt": "one\ntwo\nTHREE\n"}, nil},
		{"two conflicting files", map[string]string{"a.txt": "A\ntwo\nthree\n", "b.txt": "A\ny\nz\n"}, map[string]string{"a.txt": "B\ntwo\nthree\n", "b.txt": "B\ny\nz\n"}, []string{"a.txt", "b.txt"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := newRepo(t)
			branch(t, dir, "a", tc.a)
			branch(t, dir, "b", tc.b)
			g := gitx.New(dir)
			got, err := g.MergeTree(context.Background(), "main", "a", "b")
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("conflicts = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMergeTreeBadRefIsError(t *testing.T) {
	dir := newRepo(t)
	_, err := gitx.New(dir).MergeTree(context.Background(), "main", "nope", "main")
	if err == nil {
		t.Fatal("want an error for an unknown ref, not a conflict list")
	}
}

func TestDiffNames(t *testing.T) {
	dir := newRepo(t)
	branch(t, dir, "feat", map[string]string{"a.txt": "changed\n", "b.txt": "changed\n"})
	// main moves on; the diff is still only what feat changed (merge-base diff).
	write(t, dir, "c.txt", "later\n")
	run(t, dir, "add", ".")
	run(t, dir, "commit", "-q", "-m", "main moves")
	got, err := gitx.New(dir).DiffNames(context.Background(), "main", "feat")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"a.txt", "b.txt"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("DiffNames = %v, want %v", got, want)
	}
}

// bare returns a bare remote and a clone of it that already holds main.
func bare(t *testing.T) (remote, clone string) {
	t.Helper()
	remote = filepath.Join(t.TempDir(), "remote.git")
	run(t, t.TempDir(), "init", "-q", "--bare", "-b", "main", remote)
	clone = newRepo(t)
	run(t, clone, "remote", "add", "origin", remote)
	run(t, clone, "push", "-q", "origin", "main")
	return remote, clone
}

func TestFFPush(t *testing.T) {
	remote, a := bare(t)
	g := gitx.New(a)
	ctx := context.Background()

	write(t, a, "a.txt", "next\n")
	run(t, a, "commit", "-q", "-am", "ff")
	if err := g.FFPush(ctx, "origin", "HEAD", "main"); err != nil {
		t.Fatalf("fast-forward push: %v", err)
	}
	if got, want := run(t, remote, "rev-parse", "main"), run(t, a, "rev-parse", "HEAD"); got != want {
		t.Fatalf("remote main = %s, want %s", got, want)
	}

	// A rewritten history is not a fast-forward and must be refused, never forced.
	run(t, a, "reset", "-q", "--hard", "HEAD~1")
	write(t, a, "a.txt", "rewritten\n")
	run(t, a, "commit", "-q", "-am", "rewrite")
	err := g.FFPush(ctx, "origin", "HEAD", "main")
	if !errors.Is(err, gitx.ErrNotFastForward) {
		t.Fatalf("err = %v, want ErrNotFastForward", err)
	}
}

func TestUpdateRefCAS(t *testing.T) {
	dir := newRepo(t)
	g := gitx.New(dir)
	ctx := context.Background()
	ref := "refs/factory/lease/x"
	c1 := run(t, dir, "commit-tree", "-m", "a", "main^{tree}")
	c2 := run(t, dir, "commit-tree", "-m", "b", "-p", c1, "main^{tree}")
	c3 := run(t, dir, "commit-tree", "-m", "c", "-p", c1, "main^{tree}")

	if err := g.UpdateRef(ctx, ref, c1, ""); err != nil {
		t.Fatalf("create: %v", err)
	}
	if err := g.UpdateRef(ctx, ref, c1, ""); !errors.Is(err, gitx.ErrCASLost) {
		t.Fatalf("second create = %v, want ErrCASLost", err)
	}
	if err := g.UpdateRef(ctx, ref, c2, c1); err != nil {
		t.Fatalf("swap: %v", err)
	}
	if err := g.UpdateRef(ctx, ref, c3, c1); !errors.Is(err, gitx.ErrCASLost) {
		t.Fatalf("stale swap = %v, want ErrCASLost", err)
	}
	if got := run(t, dir, "rev-parse", ref); got != c2 {
		t.Fatalf("ref = %s, want %s", got, c2)
	}
}

func TestRemoteRefAbsent(t *testing.T) {
	_, a := bare(t)
	got, err := gitx.New(a).RemoteRef(context.Background(), "origin", "refs/factory/lease/none")
	if err != nil || got != "" {
		t.Fatalf("RemoteRef = %q, %v; want empty and nil", got, err)
	}
}
