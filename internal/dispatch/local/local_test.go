package local

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var bf = api.Brief{Ticket: "7", Attempt: 1, Name: "v9-7-a1.md", Repo: "o/r", Base: "main", Branch: "factory/7-a1", Text: "x"}

type dirWorktrees struct{ dir string }

func (d dirWorktrees) Add(context.Context, api.Brief) (string, error) { return d.dir, nil }

func script(t *testing.T, body string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "agent.sh")
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"+body), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func newLocal(t *testing.T, body string, environ []string) (*Dispatcher, string) {
	t.Helper()
	wt := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := New(ctx, Config{Worktrees: dirWorktrees{wt}, Binary: script(t, body), Environ: environ, MaxConcurrent: 3, Now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	return d, wt
}

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func wait(t *testing.T, d *Dispatcher, s api.Session) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := d.Wait(ctx, s); err != nil {
		t.Fatalf("wait: %v", err)
	}
}

// Acceptance: no ANTHROPIC_* variable reaches the child, whatever the parent env holds.
func TestChildEnvHasNoProviderVariables(t *testing.T) {
	parent := []string{
		"PATH=" + os.Getenv("PATH"), "HOME=/h", "ANTHROPIC_API_KEY=k1", "ANTHROPIC_AUTH_TOKEN=k2",
		"ANTHROPIC_BASE_URL=http://x", "anthropic_lower=1", "OPENAI_API_KEY=k3", "GEMINI_API_KEY=k4", "GOOGLE_API_KEY=k5", "CURSOR_API_KEY=k6",
	}
	d, wt := newLocal(t, "env > env.txt\n", parent)
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, d, s)
	env := read(t, filepath.Join(wt, "env.txt"))
	for _, bad := range []string{"ANTHROPIC_", "anthropic_", "OPENAI_", "GEMINI_", "GOOGLE_API_KEY", "CURSOR_API_KEY"} {
		if strings.Contains(env, bad) {
			t.Errorf("child env has %s:\n%s", bad, env)
		}
	}
	for _, want := range []string{"HOME=/h", "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1"} {
		if !strings.Contains(env, want) {
			t.Errorf("child env lacks %s", want)
		}
	}
}

func TestChildEnvFilterRows(t *testing.T) {
	got := childEnv([]string{"A=1", "ANTHROPIC_X=1", "OPENAI_API_KEY=1", "B=ANTHROPIC_Y", "MISTRAL_API_KEY=1", "COHERE_API_KEY=1", "AZURE_OPENAI_API_KEY=1"}, map[string]string{"Z": "9"})
	want := []string{"A=1", "B=ANTHROPIC_Y", "Z=9"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("got %v", got)
	}
}

func TestDispatchRunsTheClaudeArgvInTheWorktreeAndReadsUsage(t *testing.T) {
	d, wt := newLocal(t, `printf '%s\n' "$@" > args.txt
echo '{"type":"assistant","message":{"usage":{"input_tokens":10,"output_tokens":5,"cache_read_input_tokens":2,"cache_creation_input_tokens":1}}}'
echo 'not json'
echo '{"type":"result","usage":{"input_tokens":12,"output_tokens":6,"cache_read_input_tokens":2,"cache_creation_input_tokens":1},"total_cost_usd":0.25}'
`, []string{"PATH=" + os.Getenv("PATH")})
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	if s.Key != "factory-7-a1" || s.Dispatcher != "local" || s.Ticket != "7" || s.Attempt != 1 || s.ID == "" {
		t.Errorf("session %+v", s)
	}
	wait(t, d, s)
	want, _ := ClaudeArgv(ClaudeInput{Stage: "build", Issue: "7", MaxBudgetUSD: defaultBudgetUSD, Prompt: "Run `git fetch origin cloud-briefs && git show origin/cloud-briefs:v9-7-a1.md`, then follow that brief exactly."})
	args := strings.Split(strings.TrimSuffix(read(t, filepath.Join(wt, "args.txt")), "\n"), "\n")
	if len(args) < 3 || args[0] != "-p" || !strings.HasPrefix(args[1], "Run `git fetch origin cloud-briefs") {
		t.Fatalf("args %q", args[:min(3, len(args))])
	}
	if !strings.Contains(read(t, filepath.Join(wt, "args.txt")), "--settings\n"+want[indexOf(want, "--settings")+1]) {
		t.Error("settings differ from ClaudeArgv")
	}
	u, err := d.Usage(context.Background(), s)
	if err != nil {
		t.Fatal(err)
	}
	if u.InputTokens != 12 || u.OutputTokens != 6 || u.CacheReadTokens != 2 || u.CacheWriteTokens != 1 || u.CostUSD != 0.25 || u.WallTime <= 0 {
		t.Errorf("usage %+v", u)
	}
}

func indexOf(s []string, v string) int {
	for i, x := range s {
		if x == v {
			return i
		}
	}
	return -1
}

func TestUsageNeverGoesDownAcrossAssistantAndResultLines(t *testing.T) {
	d, _ := newLocal(t, `echo '{"type":"assistant","message":{"usage":{"input_tokens":50,"output_tokens":5}}}'
echo '{"type":"result","usage":{"input_tokens":10,"output_tokens":1,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
`, []string{"PATH=" + os.Getenv("PATH")})
	s, _ := d.Dispatch(context.Background(), bf)
	wait(t, d, s)
	u, _ := d.Usage(context.Background(), s)
	if u.InputTokens != 50 || u.OutputTokens != 5 {
		t.Errorf("usage %+v", u)
	}
}

func TestDispatchSameKeyStartsOneProcess(t *testing.T) {
	d, wt := newLocal(t, "echo x >> runs.txt\nsleep 1\n", []string{"PATH=" + os.Getenv("PATH")})
	a, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.Dispatch(context.Background(), bf)
	if err != nil || a != b {
		t.Fatalf("%+v %+v %v", a, b, err)
	}
	wait(t, d, a)
	if n := strings.Count(read(t, filepath.Join(wt, "runs.txt")), "x"); n != 1 {
		t.Errorf("ran %d times", n)
	}
}

func alive(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return false
	}
	s := string(b)
	return s[strings.LastIndexByte(s, ')')+2] != 'Z'
}

// Acceptance: cancel kills the whole process group, not just the child.
func TestCancelKillsTheWholeProcessGroup(t *testing.T) {
	if _, err := os.Stat("/proc/self/stat"); err != nil {
		t.Skip("needs /proc")
	}
	d, wt := newLocal(t, "sleep 300 &\necho $! > grandchild.pid\necho $$ > child.pid\nwait\n", []string{"PATH=" + os.Getenv("PATH")})
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	var gc, child int
	for i := 0; i < 200 && (gc == 0 || child == 0); i++ {
		g, _ := os.ReadFile(filepath.Join(wt, "grandchild.pid"))
		c, _ := os.ReadFile(filepath.Join(wt, "child.pid"))
		gc, _ = strconv.Atoi(strings.TrimSpace(string(g)))
		child, _ = strconv.Atoi(strings.TrimSpace(string(c)))
		time.Sleep(25 * time.Millisecond)
	}
	if gc == 0 || child == 0 || !alive(gc) || !alive(child) {
		t.Fatalf("setup: grandchild %d child %d", gc, child)
	}
	if err := d.Cancel(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 100 && (alive(gc) || alive(child)); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if alive(child) {
		t.Error("child survived cancel")
	}
	if alive(gc) {
		_ = exec.Command("kill", "-9", strconv.Itoa(gc)).Run()
		t.Error("grandchild survived cancel")
	}
	// A second cancel is harmless.
	if err := d.Cancel(context.Background(), s); err != nil {
		t.Errorf("second cancel: %v", err)
	}
}

func TestCancellingTheBaseContextKillsRuns(t *testing.T) {
	if _, err := os.Stat("/proc/self/stat"); err != nil {
		t.Skip("needs /proc")
	}
	wt := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	d, err := New(ctx, Config{Worktrees: dirWorktrees{wt}, Binary: script(t, "sleep 300 &\necho $! > gc.pid\nwait\n"), Environ: []string{"PATH=" + os.Getenv("PATH")}})
	if err != nil {
		t.Fatal(err)
	}
	s, _ := d.Dispatch(context.Background(), bf)
	var gc int
	for i := 0; i < 200 && gc == 0; i++ {
		g, _ := os.ReadFile(filepath.Join(wt, "gc.pid"))
		gc, _ = strconv.Atoi(strings.TrimSpace(string(g)))
		time.Sleep(25 * time.Millisecond)
	}
	cancel()
	wctx, wc := context.WithTimeout(context.Background(), 5*time.Second)
	defer wc()
	_ = d.Wait(wctx, s)
	for i := 0; i < 100 && alive(gc); i++ {
		time.Sleep(20 * time.Millisecond)
	}
	if alive(gc) {
		t.Error("grandchild survived the base context")
	}
}

func TestSteerIsUnsupportedAndUnknownSessionsAreErrors(t *testing.T) {
	d, _ := newLocal(t, "true\n", nil)
	if err := d.Steer(context.Background(), api.Session{}, "x"); !errors.Is(err, ErrUnsupported) {
		t.Errorf("steer %v", err)
	}
	if err := d.Cancel(context.Background(), api.Session{Key: "nope"}); err != nil {
		t.Errorf("cancel of an unknown session: %v", err)
	}
	if _, err := d.Usage(context.Background(), api.Session{Key: "nope"}); err == nil {
		t.Error("usage of an unknown session")
	}
	if c := d.Caps(); c.MaxConcurrent != 3 || c.Remote || !c.CanPushWorkflows || d.Name() != "local" {
		t.Errorf("caps %+v name %s", c, d.Name())
	}
}

func TestDispatchRejectsUnknownAgentAndBadBrief(t *testing.T) {
	d, _ := newLocal(t, "true\n", nil)
	b := bf
	b.Agent = "mystery"
	if _, err := d.Dispatch(context.Background(), b); err == nil {
		t.Error("unknown agent accepted")
	}
	b = bf
	b.Name = "wrong.md"
	if _, err := d.Dispatch(context.Background(), b); err == nil {
		t.Error("wrong brief name accepted")
	}
}

func TestGitWorktreesAddsABranchFromTheBase(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	run("commit", "-q", "--allow-empty", "-m", "base")
	run("update-ref", "refs/remotes/origin/main", "HEAD")
	root := t.TempDir()
	w := GitWorktrees{Repo: repo, Root: root}
	dir, err := w.Add(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	if dir != filepath.Join(root, "factory-7-a1") {
		t.Errorf("dir %s", dir)
	}
	out, err := exec.Command("git", "-C", dir, "rev-parse", "--abbrev-ref", "HEAD").Output()
	if err != nil || strings.TrimSpace(string(out)) != "factory/7-a1" {
		t.Errorf("branch %q %v", out, err)
	}
	// A retry finds the same worktree.
	if again, err := w.Add(context.Background(), bf); err != nil || again != dir {
		t.Errorf("retry: %s %v", again, err)
	}
	bad := bf
	bad.Branch = "--orphan"
	if _, err := w.Add(context.Background(), bad); err == nil {
		t.Error("option-shaped branch accepted")
	}
}
