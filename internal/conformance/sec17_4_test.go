package conformance

import (
	"slices"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/reconcile"
)

func dispatchIDs(as []reconcile.Action) []string {
	var out []string
	for _, a := range as {
		if a.Kind == reconcile.Dispatch {
			out = append(out, string(a.ID))
		}
	}
	return out
}

// Section 8.2 sort order: priority, then oldest creation time (zero last), then id.
func Test17_4_DispatchSortOrder(t *testing.T) {
	h := time.Hour
	a := tk("a", 2, t0.Add(h))
	b := tk("b", 1, t0.Add(2*h))
	c := tk("c", 1, t0.Add(h))
	d := tk("d", 1, time.Time{})
	e := tk("e", 1, t0.Add(h))
	p0 := tk("f", 0, t0.Add(5*h))
	cases := []struct {
		name  string
		ready []api.Ticket
		want  []string
	}{
		{"priority then age, null age last, id breaks ties", []api.Ticket{a, d, e, b, c}, []string{"c", "e", "b", "d", "a"}},
		{"input order does not matter", []api.Ticket{c, e, b, d, a}, []string{"c", "e", "b", "d", "a"}},
		{"our contract: P0 runs before P1 (the spec ranks 0 after 1..4)", []api.Ticket{a, p0, c}, []string{"f", "c", "a"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := dispatchIDs(reconcile.Decide(reconcile.State{Ready: tc.ready, FiresLeft: 100}, nil, t0, reconcile.Config{MaxConcurrent: 10}))
			if !slices.Equal(got, tc.want) {
				t.Fatalf("dispatch order %v, want %v", got, tc.want)
			}
		})
	}
}

// Section 8.5 part B: an active ticket's refreshed snapshot replaces the running entry's.
func Test17_4_ActiveRefreshUpdatesRunning(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 2}, tk("x", 1, t0))
	w.tick()
	changed := tk("x", 1, t0)
	changed.Title = "renamed"
	w.tr.Tickets["x"] = changed
	w.advance(time.Second)
	w.tick()
	e, ok := w.entry("x")
	if !ok || e.Ticket.Title != "renamed" {
		t.Fatalf("entry %+v, want the refreshed title", e)
	}
	if n := w.l.count("dispatcher.Dispatch"); n != 1 || len(w.dp.Cancels) != 0 {
		t.Fatalf("dispatches %d, cancels %v; a refresh must not restart or stop the run", n, w.dp.Cancels)
	}
}

// Section 8.5 part B: a ticket no longer active is stopped and no final phase is written for it.
func Test17_4_NonActiveStopsWithoutCleanup(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 2}, tk("x", 1, t0))
	w.tick()
	w.tr.Phases["x"] = api.PhaseNeedsHuman // the tracker no longer lists it as active
	w.l.reset()
	w.advance(time.Second)
	w.tick()
	if !slices.Equal(w.dp.Cancels, []string{"x-a1"}) {
		t.Fatalf("cancels %v, want the session stopped once", w.dp.Cancels)
	}
	if _, ok := w.entry("x"); ok {
		t.Fatal("entry still tracked after the stop")
	}
	if n := w.l.count("tracker.SetPhase"); n != 0 {
		t.Fatalf("%d tracker writes after a non-active stop, want none", n)
	}
}

// Section 8.5 part B: a terminal ticket's running session is stopped. Workspace cleanup is not part of reconcile.
func Test17_4_TerminalStopsRunning(t *testing.T) {
	x := tk("x", 1, t0)
	s := reconcile.State{
		Entries:   map[api.TicketID]reconcile.Entry{"x": {Ticket: x, Phase: api.PhaseRunning, Attempt: 2, StartedAt: t0}},
		Terminal:  map[api.TicketID]bool{"x": true},
		FiresLeft: 10,
	}
	got := reconcile.Decide(s, nil, t0, reconcile.Config{MaxConcurrent: 2})
	if len(got) != 1 || got[0].Kind != reconcile.Cancel || got[0].ID != "x" || got[0].Attempt != 2 || got[0].Reason != "terminal" {
		t.Fatalf("actions %+v, want one terminal Cancel of x attempt 2", got)
	}
}

// Section 17.4: reconciling with nothing running makes no port call except the one tracker read.
func Test17_4_NoRunningIsNoop(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 2})
	w.tick()
	w.tick()
	if got, want := w.l.all(), []string{"tracker.Ready", "tracker.Ready"}; !slices.Equal(got, want) {
		t.Fatalf("calls %v, want %v", got, want)
	}
	if got := reconcile.Decide(reconcile.State{}, nil, t0, reconcile.Config{MaxConcurrent: 2}); len(got) != 0 {
		t.Fatalf("Decide on an empty state returned %+v", got)
	}
}

// delay is the spec 8.4 formula written out by repeated doubling, apart from the code under test.
func delay(attempt int) time.Duration {
	d, limit := 10*time.Second, 5*time.Minute
	for i := 1; i < attempt && d < limit; i++ {
		d *= 2
	}
	return min(d, limit)
}

// Section 8.4: delay = min(10000 * 2^(attempt-1), cap), attempts 1 to 8, cap 5 minutes.
func Test17_4_BackoffFormula(t *testing.T) {
	want := []time.Duration{10, 20, 40, 80, 160, 300, 300, 300}
	for i, secs := range want {
		n := i + 1
		got := reconcile.Backoff(n)
		if got != secs*time.Second || got != delay(n) {
			t.Errorf("attempt %d: Backoff %v, want %v (formula %v)", n, got, secs*time.Second, delay(n))
		}
	}
	for _, n := range []int{0, -3} {
		if got := reconcile.Backoff(n); got != 10*time.Second {
			t.Errorf("attempt %d: Backoff %v, want the first delay of 10s", n, got)
		}
	}
	if got := reconcile.Backoff(1 << 20); got != 5*time.Minute {
		t.Errorf("huge attempt: Backoff %v, want the 5 minute cap", got)
	}
}

// stalledWorld runs one ticket until its first attempt has stalled past the retry threshold.
func stalledWorld(t *testing.T) *world {
	t.Helper()
	w := newWorld(t, reconcile.Config{MaxConcurrent: 1, StallAfter: time.Minute, MaxAttempts: 20}, tk("x", 1, t0))
	w.tick()
	return w
}

// Section 8.4 and 16.6: each failed attempt waits Backoff(attempt) and then starts the next attempt.
func Test17_4_AbnormalExitBackoff(t *testing.T) {
	w := stalledWorld(t)
	for n := 1; n <= 8; n++ {
		w.advance(2 * time.Minute)
		w.tick()
		e, _ := w.entry("x")
		if e.Phase != api.PhaseRetryQueue || e.Attempt != n {
			t.Fatalf("attempt %d: entry %+v, want queued for retry", n, e)
		}
		if got := e.RetryAt.Sub(w.now); got != delay(n) {
			t.Fatalf("attempt %d: retry due in %v, want %v", n, got, delay(n))
		}
		w.advance(delay(n) - time.Nanosecond)
		w.tick()
		if e, _ = w.entry("x"); e.Phase != api.PhaseRetryQueue || e.Attempt != n {
			t.Fatalf("attempt %d: dispatched %v early", n, time.Nanosecond)
		}
		w.advance(time.Nanosecond)
		w.tick()
		if e, _ = w.entry("x"); e.Phase != api.PhaseRunning || e.Attempt != n+1 {
			t.Fatalf("attempt %d: after the delay entry %+v, want attempt %d running", n, e, n+1)
		}
	}
}

// Section 8.4 retry entry: attempt, due time and identifier are kept. The error text is not stored.
func Test17_4_RetryEntryFields(t *testing.T) {
	w := stalledWorld(t)
	w.advance(2 * time.Minute)
	w.tick()
	e, ok := w.entry("x")
	if !ok || e.Attempt != 1 || e.Ticket.ID != "x" || !e.RetryAt.Equal(w.now.Add(10*time.Second)) {
		t.Fatalf("entry %+v, want attempt 1, id x, due 10s from now", e)
	}
}

// Section 8.5 part A: a quiet session is steered once, then killed and queued for retry; 0 turns detection off.
func Test17_4_StallKillsAndQueuesRetry(t *testing.T) {
	w := stalledWorld(t)
	w.advance(time.Minute)
	w.tick()
	w.tick()
	if n := w.l.count("dispatcher.Steer"); n != 1 || len(w.dp.Cancels) != 0 {
		t.Fatalf("after one stall period: %d steers, cancels %v; want one steer and no cancel", n, w.dp.Cancels)
	}
	w.advance(time.Minute)
	w.tick()
	if !slices.Equal(w.dp.Cancels, []string{"x-a1"}) {
		t.Fatalf("cancels %v, want the stalled session killed", w.dp.Cancels)
	}
	if e, _ := w.entry("x"); e.Phase != api.PhaseRetryQueue || w.tr.Phases["x"] != api.PhaseRetryQueue {
		t.Fatalf("entry %+v, tracker phase %s; want retry queued in both", e, w.tr.Phases["x"])
	}

	off := newWorld(t, reconcile.Config{MaxConcurrent: 1}, tk("y", 1, t0))
	off.tick()
	off.advance(24 * time.Hour)
	off.tick()
	if n := off.l.count("dispatcher.Steer") + len(off.dp.Cancels); n != 0 {
		t.Fatalf("stall detection off, yet %d steers or cancels", n)
	}
}

// Section 8.4 step 4: a due retry with no free slot stays queued and starts once a slot frees.
func Test17_4_SlotExhaustionKeepsRetryQueued(t *testing.T) {
	a, b := tk("a", 1, t0), tk("b", 1, t0)
	cfg := reconcile.Config{MaxConcurrent: 1}
	s := reconcile.State{
		Entries: map[api.TicketID]reconcile.Entry{
			"a": {Ticket: a, Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0},
			"b": {Ticket: b, Phase: api.PhaseRunning, Attempt: 1, StartedAt: t0},
		},
		FiresLeft: 10,
	}
	if got := dispatchIDs(reconcile.Decide(s, nil, t0, cfg)); len(got) != 0 {
		t.Fatalf("dispatched %v with every slot taken", got)
	}
	delete(s.Entries, "b")
	got := reconcile.Decide(s, nil, t0, cfg)
	if len(got) != 1 || got[0].Kind != reconcile.Dispatch || got[0].ID != "a" || got[0].Attempt != 2 {
		t.Fatalf("actions %+v, want a dispatched as attempt 2 once the slot is free", got)
	}
}

// Section 7.4: claimed and running tickets are never dispatched a second time, and the slot cap holds.
func Test17_4_NoDuplicateDispatch(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 1}, tk("a", 1, t0), tk("b", 2, t0))
	for range 3 {
		w.tick()
		w.advance(time.Second)
	}
	if got := w.l.index("dispatcher.Dispatch a a1", 0); got < 0 || w.l.count("dispatcher.Dispatch") != 1 {
		t.Fatalf("calls %v, want exactly one dispatch (a) with one slot", w.l.all())
	}
}

// Section 14.3 and 7.4: a restart reuses the session key, so a claimed ticket that never pushed gets the same session.
func Test17_4_DispatchIdempotentPerAttempt(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 1}, tk("x", 1, t0))
	w.tick()
	first, _ := w.entry("x")
	w.state = nil // process restart: no state survives
	w.advance(time.Second)
	w.tick()
	second, _ := w.entry("x")
	if w.l.count("dispatcher.Dispatch") != 2 || len(w.dp.Sessions) != 1 {
		t.Fatalf("dispatches %d, sessions %d; want two calls that share one session", w.l.count("dispatcher.Dispatch"), len(w.dp.Sessions))
	}
	if first.Session == nil || second.Session == nil || first.Session.Key != second.Session.Key {
		t.Fatalf("session keys %+v and %+v differ", first.Session, second.Session)
	}
}

// Section 14.3: after a restart the running set comes from the tracker and the observer, not memory.
func Test17_4_RestartRebuildsRunningSet(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 1}, tk("x", 1, t0))
	w.tr.Phases["x"] = api.PhaseRunning
	w.ob.Set(api.Observation{Ticket: "x", Attempt: 2, Branch: "factory/x-a2", LastPush: t0})
	w.tick()
	e, ok := w.entry("x")
	if !ok || e.Attempt != 2 || e.Phase != api.PhaseRunning {
		t.Fatalf("entry %+v, want attempt 2 running", e)
	}
	if n := w.l.count("dispatcher.Dispatch"); n != 0 {
		t.Fatalf("%d dispatches for work that is already running", n)
	}
}

// Section 8.1: the order of port calls in one tick, read from the recorded log.
func Test17_4_TickOrder(t *testing.T) {
	cfg := reconcile.Config{MaxConcurrent: 4, StallAfter: time.Minute, MaxAttempts: 5}
	w := newWorld(t, cfg, tk("a", 1, t0), tk("b", 1, t0))
	w.tick()
	w.tr.Phases["b"] = api.PhaseMerged // b turns terminal
	w.tr.Tickets["e"] = tk("e", 2, t0)
	w.tr.Phases["e"] = api.PhaseReady
	w.tr.Tickets["d"] = tk("d", 1, t0)
	w.tr.Phases["d"] = api.PhaseReady
	w.advance(2 * time.Minute) // a has been silent for two stall periods
	w.l.reset()
	w.tick()

	ready := w.l.index("tracker.Ready", 0)
	obsA := w.l.index("observer.Observe a", 0)
	stopA := w.l.index("dispatcher.Cancel a-a1", 0)
	stopB := w.l.index("dispatcher.Cancel b-a1", 0)
	dispD := w.l.index("dispatcher.Dispatch d a1", 0)
	dispE := w.l.index("dispatcher.Dispatch e a1", 0)
	claimD := w.l.index("tracker.SetPhase d claimed", 0)
	log := w.l.all()
	for name, at := range map[string]int{"Ready": ready, "Observe a": obsA, "Cancel a": stopA, "Cancel b": stopB, "Dispatch d": dispD, "Dispatch e": dispE, "claim d": claimD} {
		if at < 0 {
			t.Fatalf("no %s call in %v", name, log)
		}
	}
	if w.l.count("tracker.Ready") != 1 {
		t.Fatalf("tracker read %d times in one tick: %v", w.l.count("tracker.Ready"), log)
	}
	if w.l.index("observer.Observe b", 0) >= 0 {
		t.Fatalf("terminal b was observed: %v", log)
	}
	// Steps 1 and 3: state refresh, then observations, then every stop, before any dispatch.
	firstDispatch := min(dispD, dispE)
	for name, at := range map[string]int{"Ready": ready, "Observe a": obsA, "Cancel a": stopA, "Cancel b": stopB} {
		if at > firstDispatch {
			t.Errorf("%s at %d comes after the first dispatch at %d: %v", name, at, firstDispatch, log)
		}
	}
	if ready >= obsA || obsA >= stopA {
		t.Errorf("want Ready < Observe < Cancel, got %d, %d, %d: %v", ready, obsA, stopA, log)
	}
	if last := w.l.last("dispatcher.Cancel"); last > firstDispatch {
		t.Errorf("a stop at %d follows a dispatch at %d: %v", last, firstDispatch, log)
	}
	// Steps 4 and 5: dispatch in rank order, each claimed before it is sent.
	if claimD >= dispD || dispD >= dispE {
		t.Errorf("want claim d < Dispatch d < Dispatch e, got %d, %d, %d: %v", claimD, dispD, dispE, log)
	}
}
