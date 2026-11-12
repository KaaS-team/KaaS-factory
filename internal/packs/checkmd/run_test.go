package checkmd

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	c := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	c.Dir = dir
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return string(out)
}

func repo(t *testing.T) string {
	t.Helper()
	d := t.TempDir()
	git(t, d, "init", "-q")
	write(t, d, "a.go", "package a\n")
	git(t, d, "add", ".")
	git(t, d, "commit", "-qm", "init")
	write(t, d, "a.go", "package a\n// edited\n")
	write(t, d, "new.go", "package n\n")
	return d
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

type fakeAgent func(ctx context.Context, dir, prompt string) (string, error)

func (f fakeAgent) Run(ctx context.Context, dir, prompt string) (string, error) {
	return f(ctx, dir, prompt)
}

func worktrees(t *testing.T, d string) int {
	t.Helper()
	return strings.Count(git(t, d, "worktree", "list", "--porcelain"), "worktree ")
}

func TestRunEmptyPatchPassesAndSeesUncommittedState(t *testing.T) {
	d := repo(t)
	var seen string
	r := Runner{Repo: d, MaxDiffBytes: 1 << 20, Agent: fakeAgent(func(_ context.Context, dir, _ string) (string, error) {
		a, _ := os.ReadFile(filepath.Join(dir, "a.go"))
		n, _ := os.ReadFile(filepath.Join(dir, "new.go"))
		seen = string(a) + string(n)
		time.Sleep(2 * time.Millisecond)
		return "no issues", nil
	})}
	res := r.Run(context.Background(), []Pack{{Name: "c1", Body: "rule"}}, []string{"a.go"}, "DIFF")
	if len(res) != 1 || res[0].Name != "c1" || res[0].Status != Pass || res[0].Patch != "" || res[0].Output != "no issues" || res[0].Duration <= 0 {
		t.Fatalf("res = %+v", res)
	}
	if !strings.Contains(seen, "// edited") || !strings.Contains(seen, "package n") {
		t.Fatalf("worktree lacks uncommitted state: %q", seen)
	}
	if worktrees(t, d) != 1 {
		t.Fatal("worktree not removed")
	}
}

func TestRunPatchIsFailAndOnlyAgentChanges(t *testing.T) {
	d := repo(t)
	r := Runner{Repo: d, MaxDiffBytes: 1 << 20, Agent: fakeAgent(func(_ context.Context, dir, _ string) (string, error) {
		write(t, dir, "a.go", "package a\n")
		write(t, dir, "fresh.txt", "x\n")
		return "fixed", nil
	})}
	res := r.Run(context.Background(), []Pack{{Name: "c"}}, nil, "")[0]
	if res.Status != Fail || !strings.Contains(res.Patch, "-// edited") || !strings.Contains(res.Patch, "fresh.txt") || strings.Contains(res.Patch, "new.go") {
		t.Fatalf("res = %+v", res)
	}
}

func TestRunRemovesWorktreeOnTimeoutAndPanic(t *testing.T) {
	d := repo(t)
	r := Runner{Repo: d, Timeout: 50 * time.Millisecond, Agent: fakeAgent(func(ctx context.Context, _, _ string) (string, error) {
		<-ctx.Done()
		return "partial", ctx.Err()
	})}
	res := r.Run(context.Background(), []Pack{{Name: "slow"}}, nil, "")[0]
	if res.Status != Error || !strings.Contains(res.Output, "timeout") {
		t.Fatalf("res = %+v", res)
	}
	if worktrees(t, d) != 1 {
		t.Fatal("worktree left after timeout")
	}
	r.Agent = fakeAgent(func(context.Context, string, string) (string, error) { panic("boom") })
	res = r.Run(context.Background(), []Pack{{Name: "crash"}}, nil, "")[0]
	if res.Status != Error || !strings.Contains(res.Output, "boom") || worktrees(t, d) != 1 {
		t.Fatalf("res = %+v, worktrees %d", res, worktrees(t, d))
	}
}

func TestPromptScopeRulesAndTruncation(t *testing.T) {
	p := Pack{Name: "n", Body: "RULEBODY"}
	small := Prompt(p, []string{"a.go"}, "+line\n", 100)
	for _, want := range []string{"ONLY the changed lines", "Do NOT read, scan, or report on files outside the diff", "Do NOT report pre-existing issues", "- a.go", "+line", "RULEBODY"} {
		if !strings.Contains(small, want) {
			t.Errorf("prompt missing %q", want)
		}
	}
	if strings.Contains(small, "truncated") {
		t.Error("small diff must not be flagged truncated")
	}
	big := Prompt(p, nil, strings.Repeat("x", 500), 100)
	if !strings.Contains(big, "truncated at 100 bytes") || strings.Contains(big, strings.Repeat("x", 101)) {
		t.Errorf("diff not cut at cap with notice: %q", big)
	}
}
