package eval

import (
	"context"
	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/eval/grade"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const goPatch = `diff --git a/g.go b/g.go
--- a/g.go
+++ b/g.go
@@ -1 +1,3 @@
 package g
+
+func Sum(a, b int) int { return a + b }
`

// fakeAgent writes a shell script standing in for the agent binary. It runs in the worktree,
// applies the patch (if any) and prints one stream-json result line, as Claude Code does.
func fakeAgent(t *testing.T, patch string) string {
	t.Helper()
	dir := t.TempDir()
	body := "#!/bin/sh\n"
	if patch != "" {
		p := filepath.Join(dir, "known.patch")
		if err := os.WriteFile(p, []byte(patch), 0o644); err != nil {
			t.Fatal(err)
		}
		body += "git apply " + p + " || exit 1\n"
	}
	body += `echo '{"type":"result","usage":{"input_tokens":100,"output_tokens":20}}'` + "\n"
	bin := filepath.Join(dir, "agent.sh")
	if err := os.WriteFile(bin, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return bin
}

func goMatrix(t *testing.T) Matrix {
	t.Helper()
	m, err := LoadMatrix(fixturesDir)
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range m.Fixtures {
		if f.Name == "go-stack" {
			return Matrix{Fixtures: []Fixture{f}}
		}
	}
	t.Fatal("no go-stack fixture")
	return Matrix{}
}

// Acceptance 1: a fake agent that applies a known patch scores 1/1 on the hidden test,
// one that applies nothing scores 0/1. Dispatch goes through the local dispatcher (Symphony §10.1).
func TestLocalRunnerFakeAgentPassRate(t *testing.T) {
	cases := []struct {
		name   string
		patch  string
		merged int
	}{
		{"applies the known patch", goPatch, 1},
		{"applies nothing", "", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
			defer cancel()
			deps, err := NewLocalDeps(ctx, LocalConfig{Fixtures: fixturesDir, Agent: "claude", Workflow: "default", Binary: fakeAgent(t, c.patch), Work: t.TempDir()})
			if err != nil {
				t.Fatal(err)
			}
			sc, err := RunArm(ctx, goMatrix(t), deps, Arm{Arm: "preset", Agent: "claude"})
			if err != nil {
				t.Fatal(err)
			}
			a := sc.Aggregate
			if a.Total != 1 || a.Merged != c.merged {
				t.Fatalf("aggregate %+v, want %d of 1", a, c.merged)
			}
			r := sc.Tickets[0]
			if r.HiddenPass != (c.merged == 1) || !r.BaseGreen || r.InputTokens != 100 || r.OutputTokens != 20 || r.Attempts != 1 || r.WallTime <= 0 {
				t.Fatalf("row %+v", r)
			}
		})
	}
}

// A seed file the agent never touched stays out of the worktree's way: the fixture seed is copied,
// the hidden tests are not there before the agent finishes.
func TestLocalRunnerHidesTestsFromAgent(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	probe := filepath.Join(t.TempDir(), "probe.sh")
	script := "#!/bin/sh\nls > \"$0.ls\"\necho '{\"type\":\"result\",\"usage\":{\"input_tokens\":1}}'\n"
	if err := os.WriteFile(probe, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	deps, err := NewLocalDeps(ctx, LocalConfig{Fixtures: fixturesDir, Agent: "claude", Binary: probe, Work: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := RunArm(ctx, goMatrix(t), deps, Arm{Arm: "preset", Agent: "claude"}); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(probe + ".ls")
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "_test.go") || !strings.Contains(string(b), "g.go") {
		t.Fatalf("agent saw %q", b)
	}
}

func TestLocalDepsRejectsWhatItCannotRun(t *testing.T) {
	ctx := context.Background()
	if _, err := NewLocalDeps(ctx, LocalConfig{Fixtures: fixturesDir, Agent: "claude"}); err == nil {
		t.Fatal("want an error without a work dir")
	}
	deps, err := NewLocalDeps(ctx, LocalConfig{Fixtures: fixturesDir, Agent: "claude", Work: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	m := goMatrix(t)
	tk := m.Fixtures[0].Tickets[0].Ticket
	tk.Repo = "nowhere"
	if _, err := deps.Dispatch(ctx, tk); err == nil || !strings.Contains(err.Error(), "nowhere") {
		t.Fatalf("unknown fixture: %v", err)
	}
}

// Acceptance 1 through the command: with no runner injected, `eval` finds `claude` on PATH
// (here a fake that applies the patch), runs the matrix and writes the scorecard.
func TestEvalCommandDefaultRunnerUsesLocalDispatcher(t *testing.T) {
	bin := filepath.Dir(fakeAgent(t, goPatch))
	if err := os.Rename(filepath.Join(bin, "agent.sh"), filepath.Join(bin, "claude")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	fixtures := t.TempDir()
	if err := copyTree(filepath.Join(fixturesDir, "go-stack"), filepath.Join(fixtures, "go-stack")); err != nil {
		t.Fatal(err)
	}
	out := t.TempDir()
	cmd := NewCommand(WithNow(func() time.Time { return time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC) }))
	cmd.SetArgs([]string{"--workflow", "default", "--agent", "claude", "--fixtures", fixtures, "--out", out})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	sc, err := readScorecard(filepath.Join(out, "2026-11-12-default-claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	if sc.Aggregate.Merged != 1 || sc.Aggregate.Total != 1 {
		t.Fatalf("aggregate %+v", sc.Aggregate)
	}
}

// A ticket with a grade spec is graded from the hidden command's log, so a command that prints PASSED
// but exits non-zero does not count.
func TestLocalHiddenTestIsGradedFromTheLog(t *testing.T) {
	work := t.TempDir()
	fx := t.TempDir()
	put(t, fx, "g/hidden/1/x", "")
	spec := &grade.Spec{FailToPass: []string{"t::a"}}
	f := Fixture{Name: "g", Tickets: []FixtureTicket{{Ticket: api.Ticket{ID: "1", Repo: "g"}, Grade: spec}}}
	l := &localDeps{cfg: LocalConfig{Fixtures: fx, Work: work}, fixtures: map[string]Fixture{"g": f}}
	cases := []struct {
		command string
		want    bool
	}{
		{"echo PASSED t::a", true},
		{"echo FAILED t::a", false},
		{"echo PASSED t::a; exit 2", false},
		{"echo PASSED t::b", false},
	}
	for _, c := range cases {
		got, err := l.HiddenTest(context.Background(), f.Tickets[0].Ticket, c.command)
		if err != nil || got != c.want {
			t.Fatalf("%q: got %v, %v", c.command, got, err)
		}
	}
}
