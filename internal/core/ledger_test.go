package core

import (
	"context"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// spendTracker adds the one editable spend comment to the fake tracker, like a real adapter.
type spendTracker struct {
	listTracker
	body   map[api.TicketID]string
	writes int
}

func (s *spendTracker) SpendComment(_ context.Context, id api.TicketID) (string, error) {
	return s.body[id], nil
}

func (s *spendTracker) PutSpendComment(_ context.Context, id api.TicketID, b string) error {
	s.body[id] = b
	s.writes++
	return nil
}

func ledgerRig(t *testing.T, budgets meter.Budgets) (*rig, *spendTracker) {
	t.Helper()
	r := newRig(t, 2, budgets, tkt("a", 0))
	st := &spendTracker{listTracker: r.tr, body: map[api.TicketID]string{}}
	c, err := New(Deps{Tracker: st, Dispatcher: r.disp, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk},
		Config{Team: "alpha", Reconcile: reconcile.Config{Tick: 30 * time.Second}, EventBuffer: 256})
	if err != nil {
		t.Fatal(err)
	}
	r.c = c
	return r, st
}

// Symphony 13.5: two attempts leave one ledger comment whose totals are the sum; replaying a tick
// with the same usage changes nothing.
func TestLedgerTwoAttemptsOneComment(t *testing.T) {
	r, st := ledgerRig(t, meter.Budgets{})
	ctx := context.Background()
	if err := r.c.Dispatch(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	r.disp.UsageBy["a-a1"] = api.Usage{InputTokens: 100, OutputTokens: 40, CostUSD: 1}
	r.c.Tick(ctx)
	r.c.Tick(ctx) // the same usage event again
	if st.writes != 1 {
		t.Fatalf("writes after replay = %d, want 1", st.writes)
	}
	if err := r.c.Cancel(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.c.Retry(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	r.disp.UsageBy["a-a2"] = api.Usage{InputTokens: 30, OutputTokens: 10, CostUSD: 0.5}
	r.c.Tick(ctx)
	r.c.Tick(ctx)
	if len(r.tr.Comments["a"]) != 0 {
		t.Fatalf("ledger must edit one comment, not add %d", len(r.tr.Comments["a"]))
	}
	got, err := meter.DecodeSpend(st.body["a"])
	if err != nil || len(got) != 1 {
		t.Fatalf("markers = %v, %v", got, err)
	}
	sp := got[0]
	var in, out int64
	for _, a := range sp.Attempts {
		in += a.Input
		out += a.Output
	}
	if sp.Holder != "alpha" || len(sp.Attempts) != 2 || in != 130 || out != 50 || sp.CostUSD != 1.5 || st.writes != 2 {
		t.Fatalf("spend = %+v writes = %d", sp, st.writes)
	}
}

// Symphony 13.5: under 80 percent nothing, at 80 one steer, at 100 stop and needs-human.
func TestBudgetTable(t *testing.T) {
	for _, c := range []struct {
		name            string
		tokens          int64
		steers, cancels int
		phase           api.Phase
	}{
		{"under 80", 79, 0, 0, api.PhaseRunning},
		{"at 80", 80, 1, 0, api.PhaseRunning},
		{"at 100", 100, 0, 1, api.PhaseNeedsHuman},
	} {
		t.Run(c.name, func(t *testing.T) {
			r, _ := ledgerRig(t, meter.Budgets{Ticket: api.Budget{Tokens: 100}})
			ctx := context.Background()
			if err := r.c.Dispatch(ctx, "a"); err != nil {
				t.Fatal(err)
			}
			r.disp.UsageBy["a-a1"] = api.Usage{InputTokens: c.tokens}
			r.c.Tick(ctx)
			r.c.Tick(ctx)
			if len(r.disp.Steers) != c.steers || len(r.disp.Cancels) != c.cancels || r.tr.Phases["a"] != c.phase {
				t.Fatalf("steers %v cancels %v phase %s", r.disp.Steers, r.disp.Cancels, r.tr.Phases["a"])
			}
		})
	}
}
