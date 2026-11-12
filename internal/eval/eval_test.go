package eval

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/eval/assert"
)

type fakeDeps struct {
	passIDs map[api.TicketID]bool
	usage   map[api.TicketID][]api.Usage // successive absolute updates
}

func (f fakeDeps) Dispatch(_ context.Context, t api.Ticket) (Outcome, error) {
	return Outcome{Attempts: 1, Updates: f.usage[t.ID], Wall: 10 * time.Second}, nil
}
func (f fakeDeps) Gate(_ context.Context, _ api.Ticket) (bool, error) { return true, nil }
func (f fakeDeps) HiddenTest(_ context.Context, t api.Ticket, _ string) (bool, error) {
	return f.passIDs[t.ID], nil
}

func matrix4() Matrix {
	var ts []api.Ticket
	for _, id := range []api.TicketID{"1", "2", "3", "4"} {
		ts = append(ts, api.Ticket{ID: id})
	}
	return Matrix{Fixtures: []Fixture{{Name: "f", Tickets: toFT(ts), Hidden: "true"}}}
}

func toFT(ts []api.Ticket) []FixtureTicket {
	out := make([]FixtureTicket, len(ts))
	for i, t := range ts {
		out[i] = FixtureTicket{Ticket: t}
	}
	return out
}

// Acceptance 1: 3 of 4 pass gives 0.75 and tokens per merged PR = total / 3.
func TestScorecardPassRateAndTokensPerMergedPR(t *testing.T) {
	u := func(in, out int64) []api.Usage { return []api.Usage{{InputTokens: in, OutputTokens: out}} }
	d := fakeDeps{
		passIDs: map[api.TicketID]bool{"1": true, "2": true, "3": true},
		usage:   map[api.TicketID][]api.Usage{"1": u(100, 50), "2": u(100, 50), "3": u(100, 50), "4": u(200, 100)},
	}
	sc, err := RunArm(context.Background(), matrix4(), d, Arm{})
	if err != nil {
		t.Fatal(err)
	}
	if sc.Aggregate.PassRate != 0.75 {
		t.Fatalf("pass rate %v", sc.Aggregate.PassRate)
	}
	total := int64(150*3 + 300)
	if sc.Aggregate.TokensPerMergedPR != total/3 {
		t.Fatalf("tokens per merged PR %d want %d", sc.Aggregate.TokensPerMergedPR, total/3)
	}
	if sc.Schema != SchemaV1 || len(sc.Tickets) != 4 {
		t.Fatalf("bad scorecard %+v", sc)
	}
}

// Acceptance 2 (Symphony §13.5): repeated absolute updates count once.
func TestTokenAccountingAbsoluteTotals(t *testing.T) {
	cases := []struct {
		name    string
		updates []api.Usage
		in, out int64
	}{
		{"none", nil, 0, 0},
		{"single", []api.Usage{{InputTokens: 10, OutputTokens: 5}}, 10, 5},
		{"repeated same total", []api.Usage{{InputTokens: 10, OutputTokens: 5}, {InputTokens: 10, OutputTokens: 5}, {InputTokens: 10, OutputTokens: 5}}, 10, 5},
		{"growing totals", []api.Usage{{InputTokens: 10, OutputTokens: 5}, {InputTokens: 30, OutputTokens: 9}}, 30, 9},
		{"lower later update ignored", []api.Usage{{InputTokens: 30, OutputTokens: 9}, {InputTokens: 10, OutputTokens: 2}}, 30, 9},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in, out := AbsoluteTotals(c.updates)
			if in != c.in || out != c.out {
				t.Fatalf("got %d/%d want %d/%d", in, out, c.in, c.out)
			}
		})
	}
}

// Acceptance 3: Compare rule.
func TestCompare(t *testing.T) {
	base := Aggregate{PassRate: 0.75, TokensPerMergedPR: 1000}
	cases := []struct {
		name  string
		new   Aggregate
		worse bool
	}{
		{"same", base, false},
		{"lower pass rate", Aggregate{PassRate: 0.5, TokensPerMergedPR: 1000}, true},
		{"higher pass rate", Aggregate{PassRate: 1, TokensPerMergedPR: 1000}, false},
		{"5 percent more tokens", Aggregate{PassRate: 0.75, TokensPerMergedPR: 1050}, false},
		{"exactly 10 percent more", Aggregate{PassRate: 0.75, TokensPerMergedPR: 1100}, false},
		{"15 percent more tokens", Aggregate{PassRate: 0.75, TokensPerMergedPR: 1150}, true},
		{"fewer tokens", Aggregate{PassRate: 0.75, TokensPerMergedPR: 500}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := Compare(Scorecard{Aggregate: base}, Scorecard{Aggregate: c.new}, 0)
			if v.Worse != c.worse {
				t.Fatalf("worse=%v reason=%q", v.Worse, v.Reason)
			}
			if v.Worse && v.Reason == "" {
				t.Fatal("worse needs a reason")
			}
		})
	}
	if v := Compare(Scorecard{Aggregate: base}, Scorecard{Aggregate: Aggregate{PassRate: 0.75, TokensPerMergedPR: 1050}}, 0.01); !v.Worse {
		t.Fatal("custom margin 1% should flag 5%")
	}
}

// Acceptance 4: JSON round trip, and customer markdown hides model and cost.
func TestScorecardRoundTripAndCustomerView(t *testing.T) {
	d := fakeDeps{passIDs: map[api.TicketID]bool{"1": true}, usage: map[api.TicketID][]api.Usage{"1": {{InputTokens: 5, OutputTokens: 5, CostUSD: 1.5}}}}
	sc, err := RunArm(context.Background(), matrix4(), d, Arm{})
	if err != nil {
		t.Fatal(err)
	}
	sc.Agent = "agent-x"
	raw, err := json.Marshal(sc)
	if err != nil {
		t.Fatal(err)
	}
	var back Scorecard
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	again, _ := json.Marshal(back)
	if string(raw) != string(again) {
		t.Fatal("round trip differs")
	}
	cust := strings.ToLower(Markdown(sc, true))
	for _, bad := range []string{"agent-x", "model", "cost", "usd", "$", "token"} {
		if strings.Contains(cust, bad) {
			t.Fatalf("customer view contains %q:\n%s", bad, cust)
		}
	}
	if op := Markdown(sc, false); !strings.Contains(op, "agent-x") || !strings.Contains(op, "Tokens per merged PR") {
		t.Fatalf("operator view lacks detail:\n%s", op)
	}
}

func TestLoadSeedFixtures(t *testing.T) {
	m, err := LoadMatrix(fixturesDir)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	tickets := 0
	for _, f := range m.Fixtures {
		if f.Name == "" || len(f.Tickets) == 0 || f.Hidden == "" || f.Gate == "" {
			t.Fatalf("incomplete fixture %+v", f)
		}
		names = append(names, f.Name)
		tickets += len(f.Tickets)
		for _, tk := range f.Tickets {
			if tk.Repo != f.Name {
				t.Fatalf("%s ticket %s repo %q, want the fixture name", f.Name, tk.ID, tk.Repo)
			}
			if _, err := os.Stat(filepath.Join(fixturesDir, f.Name, "hidden", string(tk.ID))); err != nil {
				t.Fatalf("%s ticket %s has no hidden tests: %v", f.Name, tk.ID, err)
			}
		}
	}
	// go, bun, uv and one multi-ticket repo.
	if got := strings.Join(names, ","); got != "bun-add,go-stack,splitbill,uv-add" || tickets != 5 {
		t.Fatalf("fixtures %s with %d tickets", got, tickets)
	}
}

func TestMedianAndHumanTouches(t *testing.T) {
	if got := median([]time.Duration{3, 1, 2}); got != 2 {
		t.Fatal(got)
	}
	if got := median([]time.Duration{1, 3}); got != 2 {
		t.Fatal(got)
	}
	if got := median(nil); got != 0 {
		t.Fatal(got)
	}
}

// Acceptance 2: Diff says better, same or worse for each metric, in both directions.
func TestDiffVerdictPerMetric(t *testing.T) {
	mk := func(pass, green float64, tokens int64, wall time.Duration, touches float64) Scorecard {
		return Scorecard{Schema: SchemaV1, Aggregate: Aggregate{PassRate: pass, MainGreenRate: green, TokensPerMergedPR: tokens, MedianWallTime: wall, HumanTouchesPerPR: touches}}
	}
	base := mk(0.5, 1, 1000, 10*time.Second, 1)
	cases := []struct {
		name string
		next Scorecard
		want []string
	}{
		{"all better", mk(0.75, 1, 900, 8*time.Second, 0), []string{"| pass rate | 0.50 | 0.75 | +0.25 | better |", "| main green rate | 1.00 | 1.00 | +0.00 | same |", "| tokens per merged PR | 1000 | 900 | -100 (-10.0%) | better |", "| median wall time | 10s | 8s | -2s | better |", "| human touches per PR | 1.00 | 0.00 | -1.00 | better |"}},
		{"all worse", mk(0.25, 0.5, 1100, 12*time.Second, 2), []string{"| pass rate | 0.50 | 0.25 | -0.25 | worse |", "| main green rate | 1.00 | 0.50 | -0.50 | worse |", "| tokens per merged PR | 1000 | 1100 | +100 (+10.0%) | worse |", "| median wall time | 10s | 12s | +2s | worse |", "| human touches per PR | 1.00 | 2.00 | +1.00 | worse |"}},
		{"same", base, []string{"| pass rate | 0.50 | 0.50 | +0.00 | same |", "| tokens per merged PR | 1000 | 1000 | +0 (+0.0%) | same |", "| median wall time | 10s | 10s | +0s | same |"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Diff(base, c.next)
			for _, w := range c.want {
				if !strings.Contains(got, w) {
					t.Fatalf("diff lacks %q:\n%s", w, got)
				}
			}
		})
	}
}

type outputDeps struct {
	fakeDeps
	output string
}

func (d outputDeps) Dispatch(ctx context.Context, t api.Ticket) (Outcome, error) {
	o, err := d.fakeDeps.Dispatch(ctx, t)
	o.Output = d.output
	return o, err
}

// A fixture's assertions gate each epoch: hidden tests that pass do not save an output the assertions
// refuse, the epoch is decided by "assert", and a passing set leaves the scorers' decision alone.
func TestFixtureAssertionsGateTheScore(t *testing.T) {
	maxCost := 0.5
	asserts := []assert.Assertion{{Type: "contains", Value: "DONE"}, {Type: "cost", Threshold: &maxCost}}
	run := func(output string, costUSD float64) TicketResult {
		t.Helper()
		m := Matrix{Fixtures: []Fixture{{Name: "f", Tickets: toFT([]api.Ticket{{ID: "1"}}), Hidden: "true", Assert: asserts}}}
		d := outputDeps{fakeDeps{
			passIDs: map[api.TicketID]bool{"1": true},
			usage:   map[api.TicketID][]api.Usage{"1": {{InputTokens: 1, OutputTokens: 1, CostUSD: costUSD}}},
		}, output}
		sc, err := RunArm(context.Background(), m, d, Arm{})
		if err != nil {
			t.Fatal(err)
		}
		return sc.Tickets[0]
	}
	if r := run("all DONE", 0.1); !r.Merged || r.Epochs[0].DecidedBy == "assert" {
		t.Errorf("passing assertions changed the result: %+v", r)
	}
	if r := run("gave up", 0.1); r.Merged || r.Epochs[0].DecidedBy != "assert" {
		t.Errorf("a missing DONE still merged: %+v", r)
	}
	if r := run("all DONE", 2); r.Merged || r.Epochs[0].DecidedBy != "assert" {
		t.Errorf("a cost over the threshold still merged: %+v", r)
	}
}

// A malformed assertion is an error, not a silent pass.
func TestFixtureAssertionsRejectUnknownType(t *testing.T) {
	m := Matrix{Fixtures: []Fixture{{Name: "f", Tickets: toFT([]api.Ticket{{ID: "1"}}), Hidden: "true", Assert: []assert.Assertion{{Type: "bogus"}}}}}
	if _, err := RunArm(context.Background(), m, fakeDeps{passIDs: map[api.TicketID]bool{"1": true}}, Arm{}); err == nil || !strings.Contains(err.Error(), "bogus") {
		t.Fatalf("got %v", err)
	}
}
