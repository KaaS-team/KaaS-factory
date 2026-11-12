package reconcile

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

// activeTracker lists every ticket that is not finished, as a real tracker's
// ready-or-in-progress query would (API change request in the report).
type activeTracker struct{ *porttest.Tracker }

func (a activeTracker) Ready(context.Context) ([]api.Ticket, error) {
	var out []api.Ticket
	for id, t := range a.Tickets {
		switch a.Phases[id] {
		case api.PhaseReady, api.PhaseClaimed, api.PhaseRunning, api.PhaseRetryQueue:
			out = append(out, t)
		}
	}
	return out, nil
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func runningSet(s *State) map[api.TicketID]int {
	m := map[api.TicketID]int{}
	for id, e := range s.Entries {
		if e.Phase == api.PhaseRunning || e.Phase == api.PhaseStalled {
			m[id] = e.Attempt
		}
	}
	return m
}

func newDeps(tr api.Tracker, ob api.Observer, d api.Dispatcher, c *clock) Deps {
	return Deps{Dispatcher: d, Tracker: tr, Observer: ob, Now: c.now}
}

// Symphony 14.3: a restart keeps no state; the tracker and observer rebuild the running set.
func TestRestartRebuildsRunningSet(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"), tkt("b"), tkt("c"), tkt("d"))}
	ob := porttest.NewObserver()
	disp := porttest.NewDispatcher(3)
	deps := newDeps(tr, ob, disp, c)
	cf := cfg()
	cf.MaxConcurrent = 3
	ctx := context.Background()

	var state *State
	Tick(ctx, deps, &state, cf)
	if got := len(runningSet(state)); got != 3 {
		t.Fatalf("scenario should run 3 tickets, got %d", got)
	}
	// a retried once, so its live attempt is 2; every running ticket has pushed.
	var ids []string
	for id := range runningSet(state) {
		ids = append(ids, string(id))
	}
	sort.Strings(ids)
	for i, id := range ids {
		attempt := 1
		if i == 0 {
			attempt = 2
			e := state.Entries[api.TicketID(id)]
			e.Attempt = 2
			state.Entries[api.TicketID(id)] = e
		}
		ob.Set(api.Observation{Ticket: api.TicketID(id), Attempt: attempt, Branch: "factory/" + id, LastPush: t0})
	}
	before := runningSet(state)

	var restarted *State // dropped state
	Tick(ctx, deps, &restarted, cf)
	after := runningSet(restarted)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("running set changed across restart: before %v after %v", before, after)
	}
	if len(disp.Steers)+len(disp.Cancels) != 0 {
		t.Fatalf("recovery must not steer or cancel: %v %v", disp.Steers, disp.Cancels)
	}
}

func TestTickDispatchesAndCompletes(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	ob := porttest.NewObserver()
	disp := porttest.NewDispatcher(2)
	deps := newDeps(tr, ob, disp, c)
	ctx := context.Background()
	var state *State
	Tick(ctx, deps, &state, cfg())
	if tr.Phases["a"] != api.PhaseRunning || len(disp.Sessions) != 1 {
		t.Fatalf("phase %v sessions %v", tr.Phases["a"], disp.Sessions)
	}
	ob.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "factory/a-a1", LastPush: t0, HasReport: true, PR: 3})
	Tick(ctx, deps, &state, cfg())
	if tr.Phases["a"] != api.PhaseDone || len(state.Entries) != 0 {
		t.Fatalf("phase %v entries %v", tr.Phases["a"], state.Entries)
	}
}

func TestTickStallRetryNeedsHuman(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	disp := porttest.NewDispatcher(1)
	deps := newDeps(tr, porttest.NewObserver(), disp, c)
	cf := cfg()
	ctx := context.Background()
	var state *State
	Tick(ctx, deps, &state, cf)
	c.t = t0.Add(11 * time.Minute)
	Tick(ctx, deps, &state, cf)
	if len(disp.Steers) != 1 {
		t.Fatalf("want one steer, got %v", disp.Steers)
	}
	Tick(ctx, deps, &state, cf)
	if len(disp.Steers) != 1 {
		t.Fatalf("second tick must not steer again: %v", disp.Steers)
	}
	for attempt := 1; attempt < cf.MaxAttempts; attempt++ {
		c.t = c.t.Add(21 * time.Minute)
		Tick(ctx, deps, &state, cf) // retry queued
		if state.Entries["a"].Phase != api.PhaseRetryQueue || state.Entries["a"].Attempt != attempt {
			t.Fatalf("attempt %d: %+v", attempt, state.Entries["a"])
		}
		c.t = c.t.Add(Backoff(attempt))
		Tick(ctx, deps, &state, cf) // redispatched
		if state.Entries["a"].Attempt != attempt+1 {
			t.Fatalf("attempt %d not redispatched: %+v", attempt, state.Entries["a"])
		}
	}
	c.t = c.t.Add(21 * time.Minute)
	Tick(ctx, deps, &state, cf)
	if tr.Phases["a"] != api.PhaseNeedsHuman || len(tr.Comments["a"]) == 0 {
		t.Fatalf("phase %v comments %v", tr.Phases["a"], tr.Comments["a"])
	}
}

func TestTickCancelsTerminal(t *testing.T) {
	c := &clock{t0}
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	disp := porttest.NewDispatcher(1)
	deps := newDeps(tr, porttest.NewObserver(), disp, c)
	ctx := context.Background()
	var state *State
	Tick(ctx, deps, &state, cfg())
	tr.Phases["a"] = api.PhaseMerged // tracker closed it
	Tick(ctx, deps, &state, cfg())
	if !reflect.DeepEqual(disp.Cancels, []string{"a-a1"}) || len(state.Entries) != 0 {
		t.Fatalf("cancels %v entries %v", disp.Cancels, state.Entries)
	}
}

// guard fails the test when any port is called after the context is cancelled.
type guard struct {
	api.Tracker
	api.Observer
	api.Dispatcher
	ctx      context.Context
	cancelAt int32
	cancel   context.CancelFunc
	calls    atomic.Int32
	late     atomic.Int32
}

func (g *guard) hit() {
	if g.ctx.Err() != nil {
		g.late.Add(1)
	}
	if g.calls.Add(1) == g.cancelAt {
		g.cancel()
	}
}
func (g *guard) Ready(c context.Context) ([]api.Ticket, error) {
	g.hit()
	return g.Tracker.Ready(c)
}
func (g *guard) SetPhase(c context.Context, id api.TicketID, p api.Phase) error {
	g.hit()
	return g.Tracker.SetPhase(c, id, p)
}
func (g *guard) Dispatch(c context.Context, b api.Brief) (api.Session, error) {
	g.hit()
	return g.Dispatcher.Dispatch(c, b)
}
func (g *guard) Observe(c context.Context, id api.TicketID, n int) (api.Observation, error) {
	g.hit()
	return g.Observer.Observe(c, id, n)
}

func TestRunStopsOnCancel(t *testing.T) {
	for _, cancelAt := range []int32{1, 2, 3, 5} {
		ctx, cancel := context.WithCancel(context.Background())
		tr := activeTracker{porttest.NewTracker(tkt("a"), tkt("b"))}
		g := &guard{Tracker: tr, Observer: porttest.NewObserver(), Dispatcher: porttest.NewDispatcher(2), ctx: ctx, cancelAt: cancelAt, cancel: cancel}
		cf := cfg()
		cf.Tick = time.Millisecond
		done := make(chan error, 1)
		go func() {
			done <- Run(ctx, Deps{Dispatcher: g, Tracker: g, Observer: g}, cf)
		}()
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelAt %d: err %v", cancelAt, err)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("cancelAt %d: Run did not stop", cancelAt)
		}
		if g.late.Load() != 0 {
			t.Fatalf("cancelAt %d: %d port calls after cancel", cancelAt, g.late.Load())
		}
	}
}

func TestRunCancelledBeforeStartMakesNoCall(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	g := &guard{Tracker: activeTracker{porttest.NewTracker(tkt("a"))}, Observer: porttest.NewObserver(), Dispatcher: porttest.NewDispatcher(1), ctx: ctx}
	if err := Run(ctx, Deps{Dispatcher: g, Tracker: g, Observer: g}, cfg()); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	if g.calls.Load() != 0 {
		t.Fatalf("%d calls", g.calls.Load())
	}
}

func (g *guard) Name() string { return "guard" }
