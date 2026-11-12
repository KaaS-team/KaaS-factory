package eval

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

const fixturesDir = "../../evals/fixtures"

// solver is a fake agent runner that solves the tickets in its set. No model call.
type solver struct{ solves map[api.TicketID]bool }

func (s solver) Dispatch(_ context.Context, t api.Ticket) (Outcome, error) {
	return Outcome{Attempts: 1, Wall: 4 * time.Second, Updates: []api.Usage{{InputTokens: 100, OutputTokens: 20}}}, nil
}
func (s solver) Gate(context.Context, api.Ticket) (bool, error) { return true, nil }
func (s solver) HiddenTest(_ context.Context, t api.Ticket, _ string) (bool, error) {
	return s.solves[t.ID], nil
}

func newTestCommand(t *testing.T, dir string, solves map[api.TicketID]bool) (*bytes.Buffer, func(args ...string) error) {
	t.Helper()
	var out bytes.Buffer
	cmd := NewCommand(
		WithRunner(func(_ context.Context, workflow, agent, format string) (Deps, error) { return solver{solves}, nil }),
		WithNow(func() time.Time { return time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC) }),
	)
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	return &out, func(args ...string) error {
		cmd.SetArgs(args)
		return cmd.ExecuteContext(context.Background())
	}
}

// Acceptance 1: a fake run over two fixtures writes JSON and markdown that agree on every number.
func TestEvalRunWritesJSONAndMarkdownThatAgree(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "factory.lock")
	if err := os.WriteFile(lock, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	// The fixtures have five tickets; four have id 1, so the fake solves 4 of 5.
	solves := map[api.TicketID]bool{"1": true}
	_, run := newTestCommand(t, dir, solves)
	out := filepath.Join(dir, "evals")
	if err := run("--workflow", "default", "--agent", "claude", "--packs", lock, "--fixtures", fixturesDir, "--out", out); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(out, "2026-11-12-default-claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	md, err := os.ReadFile(filepath.Join(out, "2026-11-12-default-claude.md"))
	if err != nil {
		t.Fatal(err)
	}
	var sc Scorecard
	if err := json.Unmarshal(raw, &sc); err != nil {
		t.Fatal(err)
	}
	if sc.Agent != "claude" || sc.Workflow != "default" || !strings.HasPrefix(sc.Packs, "sha256:") {
		t.Fatalf("identity fields: %+v", sc)
	}
	a := sc.Aggregate
	if a.Total != 5 || a.Merged != 4 || a.PassRate != 0.8 || a.MainGreenRate != 1 || a.TokensPerMergedPR != 150 {
		t.Fatalf("aggregate %+v", a)
	}
	want := []string{
		fmt.Sprintf("- Pass rate: %.2f (%d of %d)", a.PassRate, a.Merged, a.Total),
		fmt.Sprintf("- Main green rate: %.2f", a.MainGreenRate),
		fmt.Sprintf("- Tokens per merged PR: %d", a.TokensPerMergedPR),
		fmt.Sprintf("- Median wall time: %s", a.MedianWallTime),
		fmt.Sprintf("- Human touches per PR: %.2f", a.HumanTouchesPerPR),
		"Agent: claude",
		"Workflow: default",
	}
	for _, r := range sc.Tickets {
		want = append(want, fmt.Sprintf("| %s | %s | %t | %t | %d | %d | %s | %d | %d |", r.Fixture, r.Ticket, r.HiddenPass, r.BaseGreen, r.InputTokens, r.OutputTokens, r.WallTime, r.Attempts, r.HumanTouches))
	}
	for _, w := range want {
		if !strings.Contains(string(md), w) {
			t.Fatalf("markdown lacks %q:\n%s", w, md)
		}
	}
}

func TestEvalRunRejectsBadNames(t *testing.T) {
	cases := []struct{ name, workflow, agent string }{
		{"model name as agent", "default", "claude-opus-4"},
		{"path in agent", "default", "../x"},
		{"path in workflow", "a/b", "claude"},
		{"empty agent", "default", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			_, run := newTestCommand(t, dir, nil)
			args := []string{"--workflow", c.workflow, "--fixtures", fixturesDir, "--out", dir}
			if c.agent != "" {
				args = append(args, "--agent", c.agent)
			}
			if err := run(args...); err == nil {
				t.Fatal("want error")
			}
			if es, _ := os.ReadDir(dir); len(es) != 0 {
				t.Fatalf("wrote %d files on a rejected run", len(es))
			}
		})
	}
}

func card(pass float64, tokens int64, wall time.Duration) Scorecard {
	return Scorecard{Schema: SchemaV1, Aggregate: Aggregate{PassRate: pass, MainGreenRate: 1, TokensPerMergedPR: tokens, MedianWallTime: wall}}
}

// Acceptance 2: diff table and exit code per row (better, equal, worse on pass rate, worse on tokens).
func TestEvalDiffTableAndExit(t *testing.T) {
	old := card(0.5, 1000, 10*time.Second)
	cases := []struct {
		name  string
		next  Scorecard
		worse bool
		cells []string
	}{
		{"better", card(0.75, 800, 8*time.Second), false, []string{"| pass rate | 0.50 | 0.75 | +0.25 |", "| tokens per merged PR | 1000 | 800 | -200 (-20.0%) | better |", "| median wall time | 10s | 8s | -2s |"}},
		{"equal", old, false, []string{"| pass rate | 0.50 | 0.50 | +0.00 | same |", "| tokens per merged PR | 1000 | 1000 | +0 (+0.0%) |"}},
		{"worse pass rate", card(0.25, 1000, 10*time.Second), true, []string{"| pass rate | 0.50 | 0.25 | -0.25 | worse |", "worse: pass rate fell"}},
		{"worse tokens", card(0.5, 1500, 10*time.Second), true, []string{"| tokens per merged PR | 1000 | 1500 | +500 (+50.0%) | worse |", "worse: tokens per merged PR rose"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			write := func(name string, sc Scorecard) string {
				b, _ := json.Marshal(sc)
				p := filepath.Join(dir, name)
				if err := os.WriteFile(p, b, 0o644); err != nil {
					t.Fatal(err)
				}
				return p
			}
			out, run := newTestCommand(t, dir, nil)
			err := run("diff", write("old.json", old), write("new.json", c.next))
			if c.worse != errors.Is(err, ErrWorse) || (!c.worse && err != nil) {
				t.Fatalf("worse=%v err=%v", c.worse, err)
			}
			for _, cell := range c.cells {
				if !strings.Contains(out.String(), cell) {
					t.Fatalf("table lacks %q:\n%s", cell, out)
				}
			}
			if !strings.Contains(out.String(), "main green rate") {
				t.Fatalf("no main green row:\n%s", out)
			}
		})
	}
}

func TestEvalDiffRejectsBadInput(t *testing.T) {
	dir := t.TempDir()
	bad := filepath.Join(dir, "bad.json")
	_ = os.WriteFile(bad, []byte(`{"schema":"other"}`), 0o644)
	_, run := newTestCommand(t, dir, nil)
	for _, args := range [][]string{{"diff", bad, bad}, {"diff", filepath.Join(dir, "none.json"), bad}} {
		err := run(args...)
		if err == nil || errors.Is(err, ErrWorse) {
			t.Fatalf("%v: want a plain error, got %v", args, err)
		}
	}
}

// Acceptance 3: a scorecard that names a model fails the scan, and the committed ones pass it.
func TestScorecardsNameNoModel(t *testing.T) {
	if !NamesModel(`{"agent":"claude-opus-4"}`) || !NamesModel("Sonnet") || NamesModel(`{"agent":"claude"}`) {
		t.Fatal("NamesModel misclassifies")
	}
	files, _ := filepath.Glob(filepath.Join("..", "..", "evals", "*.json"))
	if len(files) == 0 {
		t.Fatal("no committed scorecard to scan")
	}
	md, _ := filepath.Glob(filepath.Join("..", "..", "evals", "*.md"))
	for _, f := range append(files, md...) {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if NamesModel(string(b)) {
			t.Errorf("%s names a model", f)
		}
	}
}

// Acceptance 4: evals/README.md is under 20 lines and says what the files are and who writes them.
func TestEvalsReadme(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "evals", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Count(string(b), "\n")
	if lines >= 20 || lines == 0 {
		t.Fatalf("%d lines", lines)
	}
	low := strings.ToLower(string(b))
	for _, w := range []string{"scorecard", ".json", ".md", "nightly", "factory eval diff"} {
		if !strings.Contains(low, w) {
			t.Fatalf("README lacks %q", w)
		}
	}
	if strings.Contains(string(b), "—") {
		t.Fatal("em dash")
	}
}

// Trajectory acceptance: two eval runs each leave one trajectory file per ticket, and `eval compare`
// and `eval stats` read them with no runner, model or network.
func TestEvalWritesTrajectoriesAndCompareStatsReadThem(t *testing.T) {
	dir := t.TempDir()
	runOnce := func(agent string, solves map[api.TicketID]bool) string {
		_, run := newTestCommand(t, dir, solves)
		if err := run("--workflow", "default", "--agent", agent, "--fixtures", fixturesDir, "--out", dir); err != nil {
			t.Fatal(err)
		}
		return filepath.Join(dir, "2026-11-12-default-"+agent+"-trajectories")
	}
	oldDir := runOnce("old", map[api.TicketID]bool{})
	newDir := runOnce("new", map[api.TicketID]bool{"1": true})
	if files, _ := filepath.Glob(filepath.Join(newDir, "*.json")); len(files) != 5 {
		t.Fatalf("want 5 trajectory files, got %d", len(files))
	}
	for _, args := range [][]string{{"compare", oldDir, newDir}, {"stats", newDir}} {
		var out bytes.Buffer
		cmd := NewCommand() // no runner: the subcommands must not need one
		cmd.SetOut(&out)
		cmd.SetArgs(args)
		if err := cmd.Execute(); err != nil {
			t.Fatalf("%v: %v", args, err)
		}
		want := map[string]string{"compare": "Fixed: 4. Regressed: 0.", "stats": "Pass rate: 0.80"}[args[0]]
		if !strings.Contains(out.String(), want) {
			t.Fatalf("%v: want %q in\n%s", args, want, out.String())
		}
	}
}
