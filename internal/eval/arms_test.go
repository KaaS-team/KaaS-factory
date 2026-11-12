package eval

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

func armsCommand(t *testing.T, solves map[api.TicketID]bool, withControl bool) (*bytes.Buffer, func(args ...string) error) {
	t.Helper()
	var out bytes.Buffer
	opts := []Option{
		WithRunner(func(context.Context, string, string, string) (Deps, error) { return solver{solves}, nil }),
		WithNow(func() time.Time { return time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC) }),
	}
	if withControl {
		opts = append(opts, WithControl(func(context.Context, string) (BareModel, BareShell, error) {
			return &scriptModel{replies: []string{goodBlock}}, &scriptShell{out: SubmitSentinel + "\npatch\n"}, nil
		}))
	}
	cmd := NewCommand(opts...)
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	return &out, func(args ...string) error { cmd.SetArgs(args); return cmd.ExecuteContext(context.Background()) }
}

func readCard(t *testing.T, dir string) Scorecard {
	t.Helper()
	sc, err := readScorecard(filepath.Join(dir, "2026-11-12-default-claude.json"))
	if err != nil {
		t.Fatal(err)
	}
	return sc
}

// Control arm: the scorecard shows control beside preset per fixture, with exit_status recorded,
// and the headline aggregate stays the preset arm's.
func TestEvalControlArmBesidePreset(t *testing.T) {
	dir, runs := t.TempDir(), t.TempDir()
	_, run := armsCommand(t, map[api.TicketID]bool{"1": true}, true)
	if err := run("--workflow", "default", "--agent", "claude", "--format", "diff", "--arm", "preset,control", "--fixtures", "testdata", "--out", dir, "--run-dir", runs); err != nil {
		t.Fatal(err)
	}
	sc := readCard(t, dir)
	arms := map[string]int{}
	for _, c := range sc.Cells {
		arms[c.Arm]++
		if c.Format != "diff" || c.Agent != "claude" {
			t.Fatalf("axes lost: %+v", c)
		}
	}
	if arms["preset"] != 2 || arms["control"] != 2 {
		t.Fatalf("want a preset and a control cell per fixture, got %v", arms)
	}
	var ctl int
	for _, r := range sc.Tickets {
		if r.Arm == "control" {
			ctl++
			if r.ExitStatus != ExitSubmitted {
				t.Fatalf("control exit_status %q", r.ExitStatus)
			}
		}
	}
	if ctl == 0 || sc.Aggregate.Total != len(sc.Tickets)-ctl {
		t.Fatalf("aggregate mixes in the control arm: total %d tickets %d control %d", sc.Aggregate.Total, len(sc.Tickets), ctl)
	}
	md, _ := os.ReadFile(filepath.Join(dir, "2026-11-12-default-claude.md"))
	if !strings.Contains(string(md), "control/claude/diff/") || !strings.Contains(string(md), "preset/claude/diff/") {
		t.Fatalf("markdown lacks both arms:\n%s", md)
	}
	trajs, _ := filepath.Glob(filepath.Join(runs, "control*", "trajectory.json"))
	if len(trajs) != ctl {
		t.Fatalf("want a trajectory per control ticket (%d), got %d", ctl, len(trajs))
	}
}

func TestEvalFlagRejections(t *testing.T) {
	cases := []struct {
		name    string
		args    []string
		control bool
		want    string
	}{
		{"control without a model", []string{"--arm", "control"}, false, "no control model"},
		{"unknown arm", []string{"--arm", "bogus"}, true, "must be preset or control"},
		{"zero tries", []string{"--tries", "0"}, true, "at least 1"},
		{"replay without run dir", []string{"--replay"}, true, "--run-dir"},
		{"format names a model", []string{"--format", "claude-opus"}, true, "names a model"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			_, run := armsCommand(t, nil, c.control)
			err := run(append([]string{"--workflow", "default", "--agent", "claude", "--fixtures", "testdata", "--out", dir}, c.args...)...)
			if err == nil || !strings.Contains(err.Error(), c.want) {
				t.Fatalf("got %v want %q", err, c.want)
			}
			if es, _ := os.ReadDir(dir); len(es) != 0 {
				t.Fatal("wrote files on a rejected run")
			}
		})
	}
}

// Ticket 2(c) through the CLI: --replay re-scores the stored run without the runner dispatching.
func TestEvalReplayFlag(t *testing.T) {
	dir, runs := t.TempDir(), t.TempDir()
	_, run := armsCommand(t, map[api.TicketID]bool{"1": true}, false)
	if err := run("--workflow", "default", "--agent", "claude", "--fixtures", "testdata", "--out", dir, "--run-dir", runs, "--tries", "2"); err != nil {
		t.Fatal(err)
	}
	if sc := readCard(t, dir); sc.Tries != 2 || len(sc.Cells[0].PassRates) != 2 {
		t.Fatalf("tries not recorded: %+v", sc.Cells)
	}
	var out bytes.Buffer
	cmd := NewCommand(
		WithRunner(func(context.Context, string, string, string) (Deps, error) {
			return panicDispatch{solver{map[api.TicketID]bool{"1": true, "2": true}}}, nil
		}),
		WithNow(func() time.Time { return time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC) }),
	)
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--workflow", "default", "--agent", "claude", "--fixtures", "testdata", "--out", dir, "--run-dir", runs, "--tries", "2", "--replay"})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatalf("replay: %v", err)
	}
	if readCard(t, dir).Aggregate.PassRate != 1 {
		t.Fatal("replay did not re-score with the new hidden test")
	}
}

type panicDispatch struct{ solver }

func (panicDispatch) Dispatch(context.Context, api.Ticket) (Outcome, error) {
	panic("replay called a model")
}

// Ticket 2(b): eval diff lists the per-cell pass_rate_1 and malformed delta.
func TestEvalDiffCells(t *testing.T) {
	dir := t.TempDir()
	mk := func(name string, rate float64, bad int) string {
		sc := card(1, 100, time.Second)
		sc.Cells = []Cell{{Arm: "preset", Agent: "claude", Format: "diff", Fixture: "f", Tickets: 2, PassRates: []float64{rate}, Malformed: bad}}
		b, _ := json.Marshal(sc)
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, b, 0o644)
		return p
	}
	var out bytes.Buffer
	cmd := NewCommand()
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"diff", mk("a.json", 0.5, 1), mk("b.json", 1, 3)})
	if err := cmd.ExecuteContext(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "| preset/claude/diff/f | 0.50 | 1.00 | +0.50 | 1 | 3 |") {
		t.Fatalf("no cell row:\n%s", out.String())
	}
}
