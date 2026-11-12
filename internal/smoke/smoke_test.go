package smoke

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// sandbox is a bare git remote with a base branch holding one commit, and a fake GitHub over it.
type sandbox struct {
	bare string
	hub  *fakeHub
	cfg  Config
}

func newSandbox(t *testing.T, shadow bool) *sandbox {
	t.Helper()
	for _, bin := range []string{"git", "sh", "curl"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatalf("the smoke test needs %s on PATH: %v", bin, err)
		}
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	root := t.TempDir()
	bare := filepath.Join(root, "origin.git")
	seed := filepath.Join(root, "seed")
	run(t, root, "git", "init", "-q", "--bare", "-b", "main", bare)
	run(t, root, "git", "init", "-q", "-b", "main", seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("sandbox\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	run(t, seed, "git", "add", "-A")
	run(t, seed, "git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed")
	run(t, seed, "git", "push", "-q", bare, "HEAD:refs/heads/main")
	hub, srv := newFakeHub(t, bare)
	return &sandbox{bare: bare, hub: hub, cfg: Config{
		Owner: "acme", Repo: "sandbox", Token: "fake-token", APIURL: srv.URL, RemoteURL: bare,
		Shadow: shadow, Dir: filepath.Join(root, "work"), Poll: 50 * time.Millisecond, Timeout: 60 * time.Second,
		Now: func() time.Time { return time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC) },
	}}
}

func (s *sandbox) branchExists(t *testing.T, name string) bool {
	t.Helper()
	cmd := exec.Command("git", "rev-parse", "--verify", "-q", "refs/heads/"+name)
	cmd.Dir = s.bare
	return cmd.Run() == nil
}

// Symphony 8.1 (tick order), 7.4 (idempotent dispatch) and the merge stages: the whole loop through
// the merge queue, with a real git remote and the fake agent script.
func TestRunMergesTheTicket(t *testing.T) {
	s := newSandbox(t, false)
	if err := os.MkdirAll(s.cfg.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), s.cfg)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Title != "smoke 20260304T050607Z" || res.File != "smoke/20260304T050607Z.txt" {
		t.Fatalf("title %q file %q", res.Title, res.File)
	}
	if res.Issue != 1 || res.PR != 1 || !res.Merged || !res.FileOnBase {
		t.Fatalf("result %+v", res)
	}
	if out := run(t, s.bare, "git", "show", "refs/heads/main:"+res.File); !strings.Contains(out, "ticket 1") {
		t.Fatalf("file content %q", out)
	}
	for _, l := range res.Labels {
		if strings.HasPrefix(l, "factory:") {
			t.Fatalf("factory label %q left on a merged issue", l)
		}
	}
	// Cleanup closes the issue and deletes the ticket's branches.
	if err := Cleanup(context.Background(), s.cfg, res); err != nil {
		t.Fatalf("Cleanup: %v", err)
	}
	if s.hub.issue(1).state != "closed" {
		t.Fatalf("issue state %q", s.hub.issue(1).state)
	}
	for _, br := range []string{"factory/1-a1", "report/1"} {
		if s.branchExists(t, br) {
			t.Fatalf("branch %s survived Cleanup", br)
		}
	}
	if !s.branchExists(t, "main") {
		t.Fatal("Cleanup deleted the base branch")
	}
	// A second Cleanup finds nothing left to delete and still succeeds.
	if err := Cleanup(context.Background(), s.cfg, res); err != nil {
		t.Fatalf("second Cleanup: %v", err)
	}
}

func TestRunShadowMergesNothing(t *testing.T) {
	s := newSandbox(t, true)
	if err := os.MkdirAll(s.cfg.Dir, 0o755); err != nil {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), s.cfg)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Merged || res.FileOnBase || res.PR != 0 {
		t.Fatalf("shadow run changed the repo: %+v", res)
	}
	if res.Comments != 0 {
		t.Fatalf("shadow run wrote %d comments", res.Comments)
	}
	if res.Dispatches != 1 {
		t.Fatalf("shadow recorded %d dispatches, want 1", res.Dispatches)
	}
	if s.branchExists(t, "factory/1-a1") || s.branchExists(t, "report/1") {
		t.Fatal("shadow run pushed a branch")
	}
	if s.hub.sawRequest("POST", "/repos/acme/sandbox/pulls") {
		t.Fatal("shadow run opened a pull request")
	}
}

func TestRunNeedsConfig(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
	}{
		{"no repo", Config{Token: "t", Dir: "d"}},
		{"no token", Config{Owner: "o", Repo: "r", Dir: "d"}},
		{"no dir", Config{Owner: "o", Repo: "r", Token: "t"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Run(context.Background(), c.cfg); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

// The queue wrapper of a shadow run lists entries but refuses to run or enqueue anything.
func TestShadowQueueNeverRuns(t *testing.T) {
	q := shadowQueue{}
	if err := q.Enqueue(context.Background(), "1", 1); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}
	if _, err := q.Run(context.Background()); err == nil {
		t.Fatal("shadow queue ran")
	}
}

// The fake agent alone: in a worktree on a ticket branch it pushes the branch and the report and
// opens one pull request, and it puts the token on no command line.
func TestAgentScript(t *testing.T) {
	s := newSandbox(t, false)
	work := filepath.Join(t.TempDir(), "wt")
	run(t, filepath.Dir(work), "git", "clone", "-q", s.bare, work)
	run(t, work, "git", "checkout", "-q", "-b", "factory/7-a2", "origin/main")
	script := filepath.Join(t.TempDir(), "agent.sh")
	if err := os.WriteFile(script, []byte(agentScript), 0o755); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(agentScript, `-H "Authorization`) {
		t.Fatal("the script passes the token as a header argument")
	}
	cmd := exec.Command("sh", script)
	cmd.Dir = work
	cmd.Env = append(os.Environ(), "SMOKE_FILE=smoke/x.txt", "SMOKE_API_URL="+s.cfg.APIURL, "SMOKE_REPO=acme/sandbox", "SMOKE_BASE=main", "SMOKE_TOKEN=fake-token")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("agent: %v\n%s", err, out)
	}
	if got := run(t, s.bare, "git", "show", "refs/heads/factory/7-a2:smoke/x.txt"); !strings.Contains(got, "ticket 7") {
		t.Fatalf("file %q", got)
	}
	if got := run(t, s.bare, "git", "show", "refs/heads/report/7:report.md"); !strings.Contains(got, "smoke/x.txt") {
		t.Fatalf("report %q", got)
	}
	if !s.hub.sawRequest("POST", "/repos/acme/sandbox/pulls") || len(s.hub.prs) != 1 || s.hub.prs[0].head != "factory/7-a2" || s.hub.prs[0].base != "main" {
		t.Fatalf("prs %+v", s.hub.prs)
	}
	if main := run(t, s.bare, "git", "rev-parse", "main"); main != run(t, work, "git", "rev-parse", "origin/main") {
		t.Fatal("the agent moved main")
	}
}
