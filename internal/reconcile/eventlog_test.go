package reconcile

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/reconcile/eventlog"
)

// countDisp counts Dispatch calls; each call is one fire, the spend a repeated step would cost.
type countDisp struct {
	*porttest.Dispatcher
	dispatches int
}

func (c *countDisp) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	c.dispatches++
	return c.Dispatcher.Dispatch(ctx, b)
}

func logDeps(t *testing.T, dir string, tr api.Tracker, ob api.Observer, d api.Dispatcher, c *clock) (Deps, *[]error) {
	t.Helper()
	st, err := eventlog.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	var errs []error
	deps := newDeps(tr, ob, d, c)
	deps.Log = st
	deps.OnError = func(e error) { errs = append(errs, e) }
	return deps, &errs
}

// kill -9 mid-ticket: the process dies after the dispatch but before any push is observable. A fresh
// process on the same log must not dispatch again (Symphony 14.3 and 7.4).
func TestRestartReplaysLogNoRepeatedDispatch(t *testing.T) {
	c := &clock{t0}
	dir := t.TempDir()
	tr := activeTracker{porttest.NewTracker(tkt("a"), tkt("b"))}
	ob := porttest.NewObserver()
	disp := &countDisp{Dispatcher: porttest.NewDispatcher(2)}
	cf := cfg()
	ctx := context.Background()

	deps, _ := logDeps(t, dir, tr, ob, disp, c)
	var state *State
	Tick(ctx, deps, &state, cf)
	if disp.dispatches != 2 {
		t.Fatalf("setup: want 2 dispatches, got %d", disp.dispatches)
	}

	deps2, errs := logDeps(t, dir, tr, ob, disp, c) // new process, no state, nothing observed
	var restarted *State
	Tick(ctx, deps2, &restarted, cf)
	if disp.dispatches != 2 {
		t.Fatalf("restart re-ran a completed dispatch: %d", disp.dispatches)
	}
	if len(*errs) != 0 {
		t.Fatalf("errors %v", *errs)
	}
	for _, id := range []api.TicketID{"a", "b"} {
		e := restarted.Entries[id]
		if e.Phase != api.PhaseRunning || e.Attempt != 1 || e.Session == nil || e.Session.Key != string(id)+"-a1" {
			t.Fatalf("%s not restored: %+v", id, e)
		}
	}
}

// A queued retry survives the restart with its attempt count and due time instead of starting over.
func TestRestartKeepsRetryQueue(t *testing.T) {
	c := &clock{t0}
	dir := t.TempDir()
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	disp := &countDisp{Dispatcher: porttest.NewDispatcher(1)}
	cf := cfg()
	ctx := context.Background()
	deps, _ := logDeps(t, dir, tr, porttest.NewObserver(), disp, c)
	var state *State
	Tick(ctx, deps, &state, cf)
	c.t = t0.Add(21 * 60e9) // past twice StallAfter: the attempt is queued to retry
	Tick(ctx, deps, &state, cf)
	want := state.Entries["a"]
	if want.Phase != api.PhaseRetryQueue {
		t.Fatalf("setup: %+v", want)
	}
	if l, _, _ := deps.Log.Replay(); l["a"].Phase != api.PhaseRetryQueue || !l["a"].RetryAt.Equal(want.RetryAt) {
		t.Fatalf("log did not record the retry: %+v", l["a"])
	}
	deps2, _ := logDeps(t, dir, tr, porttest.NewObserver(), disp, &clock{c.t})
	var restarted *State
	Tick(ctx, deps2, &restarted, cf)
	got := restarted.Entries["a"]
	if got.Phase != api.PhaseRetryQueue || got.Attempt != want.Attempt || !got.RetryAt.Equal(want.RetryAt) {
		t.Fatalf("retry lost: got %+v want %+v", got, want)
	}
	if disp.dispatches != 1 {
		t.Fatalf("restart dispatched: %d", disp.dispatches)
	}
}

// A ticket that ended is not brought back, and one the tracker no longer lists is dropped.
func TestRestartDropsEndedAndUnlisted(t *testing.T) {
	c := &clock{t0}
	dir := t.TempDir()
	tr := activeTracker{porttest.NewTracker(tkt("a"), tkt("b"))}
	ob := porttest.NewObserver()
	disp := &countDisp{Dispatcher: porttest.NewDispatcher(2)}
	ctx := context.Background()
	deps, _ := logDeps(t, dir, tr, ob, disp, c)
	var state *State
	Tick(ctx, deps, &state, cfg())
	ob.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "factory/a-a1", LastPush: t0, HasReport: true, PR: 1})
	Tick(ctx, deps, &state, cfg()) // a is marked done and logged as ended
	if l, _, _ := deps.Log.Replay(); len(l) != 1 || l["b"].Attempt != 1 {
		t.Fatalf("done must end a in the log, got %+v", l)
	}
	tr.Phases["b"] = api.PhaseNeedsHuman
	deps2, _ := logDeps(t, dir, tr, ob, disp, c)
	var restarted *State
	Tick(ctx, deps2, &restarted, cfg())
	if len(restarted.Entries) != 0 {
		t.Fatalf("entries %+v", restarted.Entries)
	}
}

// Checksum mismatch: the log is rebuilt up to the bad line and the audit reaches OnError.
func TestRestartChecksumMismatchAudits(t *testing.T) {
	c := &clock{t0}
	dir := t.TempDir()
	tr := activeTracker{porttest.NewTracker(tkt("a"))}
	disp := &countDisp{Dispatcher: porttest.NewDispatcher(1)}
	ctx := context.Background()
	deps, _ := logDeps(t, dir, tr, porttest.NewObserver(), disp, c)
	var state *State
	Tick(ctx, deps, &state, cfg())
	p := filepath.Join(dir, "a.jsonl")
	b, _ := os.ReadFile(p)
	_ = os.WriteFile(p, []byte(strings.Replace(string(b), `"attempt":1`, `"attempt":9`, 1)), 0o600)

	deps2, errs := logDeps(t, dir, tr, porttest.NewObserver(), disp, c)
	var restarted *State
	Tick(ctx, deps2, &restarted, cfg())
	if len(*errs) != 1 || !strings.Contains((*errs)[0].Error(), "checksum") {
		t.Fatalf("want one checksum audit, got %v", *errs)
	}
	if restarted.Entries["a"].Attempt != 1 {
		t.Fatalf("state after rebuild: %+v", restarted.Entries["a"])
	}
}

// Steer and the terminal exits (needs-human, operator cancel) are logged as their own steps.
func TestStepsAreLogged(t *testing.T) {
	ctx := context.Background()
	setup := func() (Deps, *State, *clock, activeTracker) {
		c := &clock{t0}
		tr := activeTracker{porttest.NewTracker(tkt("a"))}
		deps, _ := logDeps(t, t.TempDir(), tr, porttest.NewObserver(), porttest.NewDispatcher(1), c)
		var s *State
		Tick(ctx, deps, &s, cfg())
		return deps, s, c, tr
	}
	deps, s, c, _ := setup()
	c.t = t0.Add(11 * 60e9)
	Tick(ctx, deps, &s, cfg())
	if l, _, _ := deps.Log.Replay(); l["a"].Phase != api.PhaseStalled || l["a"].SteeredAt.IsZero() {
		t.Fatalf("steer not logged: %+v", l["a"])
	}

	deps, s, c, _ = setup()
	cf := cfg()
	cf.MaxAttempts = 1
	c.t = t0.Add(21 * 60e9)
	Tick(ctx, deps, &s, cf)
	if l, _, _ := deps.Log.Replay(); len(l) != 0 || len(s.Entries) != 0 {
		t.Fatalf("needs-human must end the ticket in the log: %+v", l)
	}

	deps, s, _, _ = setup()
	s.CancelRequested = map[api.TicketID]bool{"a": true}
	Tick(ctx, deps, &s, cfg())
	if l, _, _ := deps.Log.Replay(); len(l) != 0 {
		t.Fatalf("cancel must end the ticket in the log: %+v", l)
	}
}
