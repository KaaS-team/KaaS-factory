package review

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/graph"
)

func tgit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return string(out)
}

func writeFile(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// repo returns a repository with one commit, a staged change, an unstaged change and an untracked file.
func repo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	tgit(t, dir, "init", "-q", "-b", "main")
	writeFile(t, dir, "a.go", "package a\n")
	writeFile(t, dir, "b.go", "package b\n")
	tgit(t, dir, "add", ".")
	tgit(t, dir, "commit", "-q", "-m", "init")
	writeFile(t, dir, "a.go", "package a\n\nvar Staged = 1\n")
	tgit(t, dir, "add", "a.go")
	writeFile(t, dir, "b.go", "package b\n\nvar Unstaged = 2\n")
	writeFile(t, dir, "sub/new.go", "package sub\n")
	return dir
}

type fakeSource []Check

func (f fakeSource) Checks(context.Context) ([]Check, error) { return f, nil }

type agentFunc func(ctx context.Context, dir, prompt string) (string, error)

func (f agentFunc) Run(ctx context.Context, dir, prompt string) (string, error) {
	return f(ctx, dir, prompt)
}

func worktrees(t *testing.T, dir string) string {
	return tgit(t, dir, "worktree", "list", "--porcelain")
}

// Acceptance: each check runs in a worktree seeded from HEAD plus uncommitted changes.
func TestWorktreeSeededWithUncommittedState(t *testing.T) {
	dir := repo(t)
	var seen map[string]string
	agent := agentFunc(func(_ context.Context, wt, _ string) (string, error) {
		seen = map[string]string{}
		for _, f := range []string{"a.go", "b.go", "sub/new.go"} {
			b, err := os.ReadFile(filepath.Join(wt, f))
			if err != nil {
				return "", err
			}
			seen[f] = string(b)
		}
		return "ok", nil
	})
	rs, err := Runner{Repo: dir, Source: fakeSource{{Name: "c", Instructions: "x"}}, Agent: agent}.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(seen["a.go"], "Staged") || !strings.Contains(seen["b.go"], "Unstaged") || seen["sub/new.go"] != "package sub\n" {
		t.Fatalf("worktree missed uncommitted state: %q", seen)
	}
	// The real tree is untouched and carries no worktree after the run.
	if strings.Count(worktrees(t, dir), "worktree ") != 1 {
		t.Fatalf("worktree left behind:\n%s", worktrees(t, dir))
	}
	if rs[0].Status != StatusPass {
		t.Fatalf("status %q", rs[0].Status)
	}
}

// Acceptance: result is name, status, patch, output, duration; empty patch means pass.
func TestResultRecord(t *testing.T) {
	dir := repo(t)
	n := 0
	agent := agentFunc(func(_ context.Context, wt, _ string) (string, error) {
		n++
		if n == 2 {
			writeFile(t, wt, "b.go", "package b\n\nvar Unstaged = 3\n")
			writeFile(t, wt, "made.go", "package made\n")
		}
		time.Sleep(2 * time.Millisecond)
		return "said", nil
	})
	rs, err := Runner{Repo: dir, Agent: agent, Source: fakeSource{{Name: "one"}, {Name: "two"}}}.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rs) != 2 {
		t.Fatalf("got %d results", len(rs))
	}
	if r := rs[0]; r.Name != "one" || r.Status != StatusPass || r.Patch != "" || r.Output != "said" || r.Duration <= 0 {
		t.Fatalf("empty patch must pass: %+v", r)
	}
	r := rs[1]
	if r.Status != StatusFail || r.Name != "two" {
		t.Fatalf("non-empty patch must fail: %+v", r)
	}
	// The patch holds only the agent's edits, not the seeded uncommitted state.
	if !strings.Contains(r.Patch, "+var Unstaged = 3") || !strings.Contains(r.Patch, "made.go") || strings.Contains(r.Patch, "Staged = 1") {
		t.Fatalf("patch wrong:\n%s", r.Patch)
	}
}

// Acceptance: worktree removed on crash and on timeout.
func TestWorktreeRemovedOnCrashAndTimeout(t *testing.T) {
	t.Run("panic", func(t *testing.T) {
		dir := repo(t)
		agent := agentFunc(func(context.Context, string, string) (string, error) { panic("boom") })
		func() {
			defer func() { _ = recover() }()
			_, _ = Runner{Repo: dir, Agent: agent, Source: fakeSource{{Name: "c"}}}.Run(context.Background())
		}()
		if strings.Count(worktrees(t, dir), "worktree ") != 1 {
			t.Fatalf("worktree left after panic:\n%s", worktrees(t, dir))
		}
	})
	t.Run("timeout", func(t *testing.T) {
		dir := repo(t)
		var wtDir string
		agent := agentFunc(func(ctx context.Context, wt, _ string) (string, error) {
			wtDir = wt
			<-ctx.Done()
			return "partial", ctx.Err()
		})
		rs, err := Runner{Repo: dir, Agent: agent, Timeout: 20 * time.Millisecond, Source: fakeSource{{Name: "c"}}}.Run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if rs[0].Status != StatusTimeout {
			t.Fatalf("status %q", rs[0].Status)
		}
		if _, err := os.Stat(wtDir); !os.IsNotExist(err) {
			t.Fatalf("worktree dir still there: %v", err)
		}
		if strings.Count(worktrees(t, dir), "worktree ") != 1 {
			t.Fatal("worktree still registered")
		}
	})
	t.Run("agent error", func(t *testing.T) {
		dir := repo(t)
		agent := agentFunc(func(context.Context, string, string) (string, error) { return "", errors.New("died") })
		rs, err := Runner{Repo: dir, Agent: agent, Source: fakeSource{{Name: "c"}}}.Run(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		if rs[0].Status != StatusError || !strings.Contains(rs[0].Output, "died") {
			t.Fatalf("%+v", rs[0])
		}
		if strings.Count(worktrees(t, dir), "worktree ") != 1 {
			t.Fatal("worktree left")
		}
	})
}

// Acceptance: the diff is truncated at the byte cap with a notice; the prompt is diff-only and scoped.
func TestPromptScopeAndTruncation(t *testing.T) {
	dir := repo(t)
	var prompts []string
	agent := agentFunc(func(_ context.Context, _, p string) (string, error) {
		prompts = append(prompts, p)
		return "", nil
	})
	for _, cap := range []int{0, 40} {
		if _, err := (Runner{Repo: dir, Agent: agent, DiffCap: cap, Source: fakeSource{{Name: "c", Instructions: "RULE-TEXT"}}}).Run(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	full, cut := prompts[0], prompts[1]
	for _, want := range []string{"RULE-TEXT", "ONLY the changed lines", "Do NOT read", "pre-existing", "+var Staged = 1", "sub/new.go", "a.go"} {
		if !strings.Contains(full, want) {
			t.Errorf("prompt missing %q:\n%s", want, full)
		}
	}
	if strings.Contains(full, "truncated") {
		t.Error("untruncated diff carries a notice")
	}
	if !strings.Contains(cut, "truncated") || strings.Contains(cut, "+var Staged = 1") {
		t.Errorf("diff not cut at cap:\n%s", cut)
	}
	if len(diffBody(cut)) > 40 {
		t.Errorf("diff body %d bytes over cap 40", len(diffBody(cut)))
	}
}

func diffBody(p string) string {
	_, rest, _ := strings.Cut(p, "```diff\n")
	body, _, _ := strings.Cut(rest, "\n```")
	return body
}

// Acceptance: the review-only workflow file loads through the graph loader.
func TestWorkflowFileLoads(t *testing.T) {
	g, err := graph.Load("review-only.yml")
	if err != nil {
		t.Fatal(err)
	}
	if g.Name != "review-only" {
		t.Fatalf("name %q", g.Name)
	}
}
