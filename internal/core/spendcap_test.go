package core

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// Symphony 13.5: a ticket whose ledger spend has reached the cap is refused before the dispatcher
// is called; the reason names no cost; the cap lands in the ledger. Under the cap it dispatches.
func TestSessionCapRefusesBeforeDispatch(t *testing.T) {
	for _, c := range []struct {
		name    string
		spent   float64
		refused bool
	}{{"under", 1, false}, {"at cap", 2, true}, {"over", 3, true}} {
		t.Run(c.name, func(t *testing.T) {
			r, st := ledgerRig(t, meter.Budgets{})
			cc, err := New(Deps{Tracker: st, Dispatcher: r.disp, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk},
				Config{Team: "alpha", SessionCap: 2, Reconcile: reconcile.Config{Tick: 30 * time.Second}, EventBuffer: 16})
			if err != nil {
				t.Fatal(err)
			}
			st.body["a"] = meter.EncodeSpend(meter.Spend{Holder: "alpha", CostUSD: c.spent, Runs: 1,
				Attempts: []meter.AttemptTokens{{N: 1, Input: 5}}})
			err = cc.Dispatch(context.Background(), "a")
			if c.refused {
				if err == nil || strings.ContainsAny(err.Error(), "$0123456789") || len(r.disp.Sessions) != 0 {
					t.Fatalf("err = %v, sessions = %d", err, len(r.disp.Sessions))
				}
				if !strings.Contains(st.body["a"], `"capUsd":2,"spentUsd":`) {
					t.Fatalf("cap not in ledger: %q", st.body["a"])
				}
				return
			}
			if err != nil || len(r.disp.Sessions) != 1 {
				t.Fatalf("err = %v, sessions = %d", err, len(r.disp.Sessions))
			}
		})
	}
}

// noThread is a tracker that cannot read or write a ticket's spend comment.
type noThread struct{ api.Tracker }

// A cap that cannot be checked must not fail open: a tracker that cannot return the ledger refuses
// the dispatch with an error naming it; with no cap configured the same tracker dispatches.
func TestSessionCapFailsClosedWithoutLedger(t *testing.T) {
	for _, c := range []struct {
		name    string
		cap     float64
		refused bool
	}{{"cap configured", 2, true}, {"no cap", 0, false}} {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
			tr := noThread{r.tr}
			if _, ok := any(tr).(meter.Thread); ok {
				t.Fatal("wrapper unexpectedly implements meter.Thread")
			}
			cc, err := New(Deps{Tracker: tr, Dispatcher: r.disp, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk},
				Config{Team: "alpha", SessionCap: c.cap, Reconcile: reconcile.Config{Tick: 30 * time.Second}, EventBuffer: 16})
			if err != nil {
				t.Fatal(err)
			}
			err = cc.Dispatch(context.Background(), "a")
			if c.refused {
				if err == nil || !strings.Contains(err.Error(), "noThread") || len(r.disp.Sessions) != 0 {
					t.Fatalf("err = %v, sessions = %d", err, len(r.disp.Sessions))
				}
				return
			}
			if err != nil || len(r.disp.Sessions) != 1 {
				t.Fatalf("err = %v, sessions = %d", err, len(r.disp.Sessions))
			}
		})
	}
}
