package reconcile

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/pick"
)

type failObserver struct {
	*porttest.Observer
	fail bool
}

func (f *failObserver) Observe(ctx context.Context, id api.TicketID, n int) (api.Observation, error) {
	if f.fail {
		return api.Observation{}, errors.New("observer down")
	}
	return f.Observer.Observe(ctx, id, n)
}

type failTracker struct {
	activeTracker
	fail bool
}

func (f *failTracker) Ready(ctx context.Context) ([]api.Ticket, error) {
	if f.fail {
		return nil, errors.New("tracker down")
	}
	return f.activeTracker.Ready(ctx)
}

// Symphony 8.5: a failed refresh keeps workers running; no stall decision that tick.
func TestTickObserverFailureSkipsStall(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	ob := &failObserver{Observer: porttest.NewObserver()}
	disp := porttest.NewDispatcher(1)
	deps := newDeps(tr, ob, disp, c)
	ctx := context.Background()
	var state *State
	Tick(ctx, deps, &state, cfg())
	ob.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "f", LastPush: t0})
	c.t = t0.Add(5 * time.Minute)
	Tick(ctx, deps, &state, cfg())
	if state.Entries["a"].LastObs.LastPush != t0 {
		t.Fatalf("last good observation not kept: %+v", state.Entries["a"].LastObs)
	}
	ob.fail = true
	c.t = t0.Add(25 * time.Minute) // past 2x StallAfter from StartedAt
	Tick(ctx, deps, &state, cfg())
	if len(disp.Steers)+len(disp.Cancels) != 0 || state.Entries["a"].Phase != api.PhaseRunning {
		t.Fatalf("stall decided on a failed observation: steers %v cancels %v", disp.Steers, disp.Cancels)
	}
	ob.fail = false
	ob.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "f", LastPush: c.t.Add(-time.Minute)})
	Tick(ctx, deps, &state, cfg())
	if len(disp.Steers)+len(disp.Cancels) != 0 {
		t.Fatalf("healthy session acted on after recovery: %v %v", disp.Steers, disp.Cancels)
	}
}

// Symphony 8.1: reconcile running work first; a Ready failure skips only new dispatch.
func TestTickReadyFailureStillReconciles(t *testing.T) {
	c := &clock{t0}
	base := activeTracker{porttest.NewTracker(tkt("a"), tkt("b"))}
	tr := &failTracker{activeTracker: base}
	disp := porttest.NewDispatcher(2)
	deps := newDeps(tr, porttest.NewObserver(), disp, c)
	cf := cfg()
	cf.MaxConcurrent = 1
	ctx := context.Background()
	var state *State
	Tick(ctx, deps, &state, cf)
	if len(disp.Sessions) != 1 {
		t.Fatalf("setup: %v", disp.Sessions)
	}
	tr.fail = true
	c.t = t0.Add(11 * time.Minute)
	Tick(ctx, deps, &state, cf)
	if len(disp.Steers) != 1 {
		t.Fatalf("stall check skipped when Ready failed: %v", disp.Steers)
	}
	c.t = t0.Add(25 * time.Minute)
	Tick(ctx, deps, &state, cf) // retry queued
	c.t = c.t.Add(time.Hour)
	Tick(ctx, deps, &state, cf) // retry is due but dispatch is skipped
	if len(disp.Sessions) != 1 {
		t.Fatalf("dispatched while Ready failed: %v", disp.Sessions)
	}
	tr.fail = false
	Tick(ctx, deps, &state, cf)
	if len(disp.Sessions) != 2 {
		t.Fatalf("dispatch did not resume: %v", disp.Sessions)
	}
}

// Symphony 8.1 and 8.5: a Ready failure on a fresh process has no state to reconcile.
func TestTickReadyFailureFreshStartIsNoop(t *testing.T) {
	tr := &failTracker{activeTracker: activeTracker{porttest.NewTracker(tkt("a"))}, fail: true}
	disp := porttest.NewDispatcher(1)
	var state *State
	Tick(context.Background(), newDeps(tr, porttest.NewObserver(), disp, &clock{t0}), &state, cfg())
	if len(disp.Sessions) != 0 {
		t.Fatal("dispatched")
	}
}

// Symphony 8.4: delay = min(10s*2^(n-1), MaxRetryBackoff).
func TestMaxRetryBackoff(t *testing.T) {
	cases := []struct {
		name string
		max  time.Duration
		n    int
		want time.Duration
	}{
		{"default caps attempt 8 at 5m", 0, 8, 5 * time.Minute},
		{"1m caps attempt 8", time.Minute, 8, time.Minute},
		{"1m leaves attempt 3", time.Minute, 3, 40 * time.Second},
		{"1m caps attempt 7", time.Minute, 7, time.Minute},
		{"cap under base", 5 * time.Second, 1, 5 * time.Second},
		{"huge attempt", time.Minute, 1 << 20, time.Minute},
		{"cap above default", 10 * time.Minute, 8, 10 * time.Minute},
	}
	for _, tc := range cases {
		cf := Config{MaxRetryBackoff: tc.max}.withDefaults()
		if got := cf.backoff(tc.n); got != tc.want {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
	got := Decide(st(running("a", 8, t0)), []api.Observation{obsPush("a", 8, t0.Add(-time.Hour))}, t0.Add(time.Hour), Config{StallAfter: time.Minute, MaxAttempts: 20, MaxConcurrent: 1, MaxRetryBackoff: time.Minute})
	if len(got) != 1 || got[0].Kind != Retry || got[0].At != t0.Add(time.Hour+time.Minute) {
		t.Fatalf("Decide retry delay: %+v", got)
	}
}

// Symphony 8.4: the retry entry stores the error; slot exhaustion records its reason.
func TestRetryEntryError(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"), tkt("b"))}
	disp := porttest.NewDispatcher(2)
	deps := newDeps(tr, porttest.NewObserver(), disp, c)
	cf := cfg()
	cf.MaxConcurrent = 1
	ctx := context.Background()
	var state *State
	Tick(ctx, deps, &state, cf)
	c.t = t0.Add(25 * time.Minute)
	Tick(ctx, deps, &state, cf) // retry
	if e := state.Entries["a"]; e.Phase != api.PhaseRetryQueue || e.Error != "stalled" {
		t.Fatalf("entry %+v, want error stalled", e)
	}
	// Another ticket takes the only slot while a waits for its retry.
	state.Entries["b"] = Entry{Ticket: tkt("b"), Phase: api.PhaseRunning, Attempt: 1, StartedAt: c.t}
	c.t = c.t.Add(time.Hour)
	Tick(ctx, deps, &state, cf)
	if e := state.Entries["a"]; e.Phase != api.PhaseRetryQueue || e.Error != SlotsExhausted {
		t.Fatalf("entry %+v, want error %q", e, SlotsExhausted)
	}
}

// Symphony 8.4: a failed dispatch queues a retry carrying the error text.
func TestDispatchFailureStoresError(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	disp := porttest.NewDispatcher(1)
	disp.Err = errors.New("no capacity")
	deps := newDeps(tr, porttest.NewObserver(), disp, c)
	deps.OnError = func(error) {}
	var state *State
	Tick(context.Background(), deps, &state, cfg())
	if e := state.Entries["a"]; e.Phase != api.PhaseRetryQueue || e.Error != "no capacity" {
		t.Fatalf("entry %+v", e)
	}
}

// Symphony 14.3: Locks given in Deps are known to the first Decide after a fresh start.
func TestInitialLocksReachFirstDecide(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a", "x.go"))}
	disp := porttest.NewDispatcher(1)
	deps := newDeps(tr, porttest.NewObserver(), disp, c)
	deps.InitialLocks = pick.Locks{Files: []string{"x.go"}}
	var state *State
	Tick(context.Background(), deps, &state, cfg())
	if len(disp.Sessions) != 0 {
		t.Fatalf("dispatched onto a held file: %v", disp.Sessions)
	}
	if len(state.Locks.Files) != 1 {
		t.Fatalf("locks %+v", state.Locks)
	}
}
