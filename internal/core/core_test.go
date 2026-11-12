package core

import (
	"context"
	"errors"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/reconcile/eventlog"
	"github.com/KaaS-team/factory/internal/store"
)

var _ api.Control = (*Core)(nil)

var t0 = time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)

// fakeClock only moves when a test advances it.
type fakeClock struct {
	mu      sync.Mutex
	t       time.Time
	waiters []waiter
}

type waiter struct {
	at time.Time
	ch chan time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) After(d time.Duration) <-chan time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	ch := make(chan time.Time, 1)
	c.waiters = append(c.waiters, waiter{c.t.Add(d), ch})
	return ch
}

func (c *fakeClock) waiting() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.waiters)
}

func (c *fakeClock) advance(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
	keep := c.waiters[:0]
	for _, w := range c.waiters {
		if !w.at.After(c.t) {
			w.ch <- c.t
		} else {
			keep = append(keep, w)
		}
	}
	c.waiters = keep
}

// listTracker lists every unfinished ticket as Ready and as Active, like a real tracker's in-progress query.
type listTracker struct{ *porttest.Tracker }

func (l listTracker) unfinished(phases ...api.Phase) []api.Ticket {
	var out []api.Ticket
	for id, t := range l.Tickets {
		for _, p := range phases {
			if l.Phases[id] == p {
				out = append(out, t)
			}
		}
	}
	return out
}

func (l listTracker) Ready(context.Context) ([]api.Ticket, error) {
	return l.unfinished(api.PhaseReady, api.PhaseClaimed, api.PhaseRunning, api.PhaseRetryQueue), nil
}

func (l listTracker) Active(context.Context) ([]api.Ticket, error) {
	return l.unfinished(api.PhaseClaimed, api.PhaseRunning, api.PhaseRetryQueue), nil
}

// fakeQueue lands everything queued on Run.
type fakeQueue struct {
	mu     sync.Mutex
	queued []mergeq.Entry
	prs    map[string]int
}

func (q *fakeQueue) Enqueue(_ context.Context, id api.TicketID, pr int) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.prs == nil {
		q.prs = map[string]int{}
	}
	q.queued = append(q.queued, mergeq.Entry{ID: string(id)})
	q.prs[string(id)] = pr
	return nil
}

func (q *fakeQueue) Queued(context.Context) ([]mergeq.Entry, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	return append([]mergeq.Entry(nil), q.queued...), nil
}

func (q *fakeQueue) Run(context.Context) (mergeq.Report, error) {
	q.mu.Lock()
	defer q.mu.Unlock()
	var rep mergeq.Report
	for _, e := range q.queued {
		rep.Landed = append(rep.Landed, e.ID)
	}
	if len(q.queued) > 0 {
		rep.GateRuns = 1
	}
	q.queued = nil
	return rep, nil
}

type rig struct {
	c    *Core
	clk  *fakeClock
	tr   listTracker
	obs  *porttest.Observer
	disp *porttest.Dispatcher
	mq   *fakeQueue
	st   *store.Store
	m    *meter.Meter
}

func tkt(id string, prio int, files ...string) api.Ticket {
	return api.Ticket{ID: api.TicketID(id), Repo: "r", Title: "t " + id, Priority: prio, Files: files, CreatedAt: t0}
}

func newRig(t *testing.T, slots int, budgets meter.Budgets, tickets ...api.Ticket) *rig {
	t.Helper()
	r := &rig{clk: &fakeClock{t: t0}, tr: listTracker{porttest.NewTracker(tickets...)}, obs: porttest.NewObserver(),
		disp: porttest.NewDispatcher(slots), mq: &fakeQueue{}}
	var err error
	if r.st, err = store.Open(filepath.Join(t.TempDir(), "s.db")); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = r.st.Close() })
	r.m = meter.New(budgets, r.clk.Now)
	r.c, err = New(Deps{Tracker: r.tr, Dispatcher: r.disp, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk},
		Config{Reconcile: reconcile.Config{Tick: 30 * time.Second}, EventBuffer: 256})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// events collects every event except ticks and pushes until stop is called.
func collect(t *testing.T, c *Core) (get func() []api.Event) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ch, err := c.Events(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	var got []api.Event
	go func() {
		for ev := range ch {
			mu.Lock()
			got = append(got, ev)
			mu.Unlock()
		}
	}()
	return func() []api.Event {
		// Events are handed over by a goroutine; give it a moment to catch up.
		deadline := time.Now().Add(time.Second)
		for time.Now().Before(deadline) && len(ch) > 0 {
			time.Sleep(time.Millisecond)
		}
		time.Sleep(10 * time.Millisecond)
		mu.Lock()
		defer mu.Unlock()
		var out []api.Event
		for _, e := range got {
			if e.Kind != KindTick && e.Kind != KindPushed {
				out = append(out, e)
			}
		}
		return out
	}
}

func kinds(evs []api.Event) []string {
	var out []string
	for _, e := range evs {
		out = append(out, e.Kind+":"+string(e.Ticket))
	}
	return out
}

func eq(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

// Symphony 8.3 and 8.1: two slots dispatch two of three ready tickets; the third starts after one lands.
func TestTwoSlotsThreeTicketsThirdAfterMerge(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0, "a/"), tkt("b", 1, "b/"), tkt("c", 2, "c/"))
	get := collect(t, r.c)
	ctx := context.Background()

	r.c.Tick(ctx)
	if len(r.disp.Sessions) != 2 {
		t.Fatalf("sessions after first tick = %d, want 2", len(r.disp.Sessions))
	}
	r.clk.advance(30 * time.Second)
	r.c.Tick(ctx)
	if len(r.disp.Sessions) != 2 {
		t.Fatalf("a full board must not dispatch, sessions = %d", len(r.disp.Sessions))
	}

	r.obs.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "factory/a-a1", HasReport: true, PR: 7, LastPush: t0.Add(time.Minute)})
	r.clk.advance(30 * time.Second)
	r.c.Tick(ctx) // a is done, queued and merged; its slot frees at the end of this pass
	r.clk.advance(30 * time.Second)
	r.c.Tick(ctx)

	want := []string{"dispatched:a", "dispatched:b", "queued:a", "gate:", "merged:a", "dispatched:c"}
	if got := kinds(get()); !eq(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
	if r.tr.Phases["a"] != api.PhaseMerged {
		t.Fatalf("a phase = %s, want merged", r.tr.Phases["a"])
	}
	if r.mq.prs["a"] != 7 {
		t.Fatalf("queued pr = %d, want 7", r.mq.prs["a"])
	}
}

// Control: each manual call reaches the dispatcher once and emits one event.
func TestManualControl(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, r *rig)
		do    func(ctx context.Context, c *Core) error
		check func(t *testing.T, r *rig)
		event string
	}{
		{"dispatch", func(*testing.T, *rig) {},
			func(ctx context.Context, c *Core) error { return c.Dispatch(ctx, "a") },
			func(t *testing.T, r *rig) {
				if _, ok := r.disp.Sessions["a-a1"]; !ok || len(r.disp.Sessions) != 1 {
					t.Fatalf("sessions = %v", r.disp.Sessions)
				}
			}, KindDispatched},
		{"steer", dispatched,
			func(ctx context.Context, c *Core) error { return c.Steer(ctx, "a", "hurry") },
			func(t *testing.T, r *rig) {
				if len(r.disp.Steers) != 1 || r.disp.Steers[0] != "a-a1: hurry" {
					t.Fatalf("steers = %v", r.disp.Steers)
				}
			}, KindSteered},
		{"cancel", dispatched,
			func(ctx context.Context, c *Core) error { return c.Cancel(ctx, "a") },
			func(t *testing.T, r *rig) {
				if len(r.disp.Cancels) != 1 || r.disp.Cancels[0] != "a-a1" {
					t.Fatalf("cancels = %v", r.disp.Cancels)
				}
				if r.tr.Phases["a"] != api.PhaseCanceled {
					t.Fatalf("phase = %s", r.tr.Phases["a"])
				}
			}, KindCanceled},
		{"retry", dispatched,
			func(ctx context.Context, c *Core) error { return c.Retry(ctx, "a") },
			func(t *testing.T, r *rig) {
				if _, ok := r.disp.Sessions["a-a2"]; !ok || len(r.disp.Sessions) != 2 {
					t.Fatalf("sessions = %v", r.disp.Sessions)
				}
				if len(r.disp.Cancels) != 1 || r.disp.Cancels[0] != "a-a1" {
					t.Fatalf("old session must be canceled once, cancels = %v", r.disp.Cancels)
				}
				b, _ := r.c.Board(context.Background())
				if len(b.Slots) != 1 || b.Slots[0].Session == nil || b.Slots[0].Session.Attempt != 2 {
					t.Fatalf("board = %+v", b.Slots)
				}
			}, KindRetried},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
			tc.setup(t, r)
			get := collect(t, r.c)
			if err := tc.do(context.Background(), r.c); err != nil {
				t.Fatal(err)
			}
			tc.check(t, r)
			if got := kinds(get()); !eq(got, []string{tc.event + ":a"}) {
				t.Fatalf("events = %v, want one %s", got, tc.event)
			}
		})
	}
}

func dispatched(t *testing.T, r *rig) {
	t.Helper()
	if err := r.c.Dispatch(context.Background(), "a"); err != nil {
		t.Fatal(err)
	}
	r.disp.Steers, r.disp.Cancels = nil, nil
}

func TestManualControlErrors(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
	ctx := context.Background()
	for name, err := range map[string]error{
		"steer untracked":  r.c.Steer(ctx, "a", "x"),
		"cancel untracked": r.c.Cancel(ctx, "a"),
		"dispatch unknown": r.c.Dispatch(ctx, "zzz"),
	} {
		if err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	if err := r.c.Dispatch(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.c.Dispatch(ctx, "a"); err == nil {
		t.Error("dispatch twice: want error")
	}
	if len(r.disp.Sessions) != 1 {
		t.Errorf("sessions = %d, want 1", len(r.disp.Sessions))
	}
}

// Retry of a ticket the loop gave up on starts the next attempt after the last one used.
func TestRetryAfterNeedsHuman(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
	ctx := context.Background()
	if err := r.c.Dispatch(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.c.Cancel(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := r.c.Retry(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if _, ok := r.disp.Sessions["a-a2"]; !ok {
		t.Fatalf("sessions = %v", r.disp.Sessions)
	}
}

// A subscriber that never reads is dropped after its buffer fills; the loop keeps ticking.
func TestSlowSubscriberDroppedLoopKeepsTicking(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
	r.c.hub = newHub(2, r.clk.Now)
	slow, err := r.c.Events(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	fast, err := r.c.Events(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var ticks, dropped int
	done := make(chan struct{})
	go func() {
		defer close(done)
		for ev := range fast {
			switch ev.Kind {
			case KindTick:
				ticks++
			case KindSubscriberDropped:
				dropped++
			}
			if ticks >= 6 {
				return
			}
		}
	}()
	runDone := make(chan error, 1)
	go func() { runDone <- r.c.Run(ctx) }()
	for i := 0; i < 6; i++ {
		for r.clk.waiting() == 0 {
			select {
			case <-done:
			default:
				time.Sleep(time.Millisecond)
				continue
			}
			break
		}
		r.clk.advance(30 * time.Second)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("loop stalled behind a slow subscriber")
	}
	cancel()
	if err := <-runDone; !errors.Is(err, context.Canceled) {
		t.Fatalf("Run = %v, want context canceled", err)
	}
	if ticks < 6 || dropped != 1 {
		t.Fatalf("ticks = %d, dropped = %d, want >= 6 and 1", ticks, dropped)
	}
	n := 0
	for range slow { // closed by the drop, so this ends
		n++
	}
	if n > 2 {
		t.Fatalf("slow subscriber buffered %d events, bound is 2", n)
	}
}

// Symphony 14.3: a new Core rebuilds the running set from the tracker's Active list and observer.
func TestRestartShowsRunningTicketWithoutDispatch(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0), tkt("b", 1))
	r.tr.Phases["a"] = api.PhaseRunning
	r.obs.Set(api.Observation{Ticket: "a", Attempt: 2, Branch: "factory/a-a2", LastPush: t0.Add(-time.Minute)})
	ctx := context.Background()

	b, err := r.c.Board(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Slots) != 1 || b.Slots[0].Ticket.ID != "a" || b.Slots[0].Phase != api.PhaseRunning {
		t.Fatalf("board = %+v", b.Slots)
	}
	r.c.Tick(ctx)
	if _, ok := r.disp.Sessions["a-a2"]; ok {
		t.Fatal("running ticket was dispatched again")
	}
	if _, ok := r.disp.Sessions["a-a1"]; ok {
		t.Fatal("running ticket was dispatched again")
	}
	if _, ok := r.disp.Sessions["b-a1"]; !ok {
		t.Fatalf("ready ticket b must still start, sessions = %v", r.disp.Sessions)
	}
}

// Without api.Lister, startup rebuilds from Ready.
func TestRestartFromReadyWithoutLister(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
	r.c.d.Tracker = readyOnly{r.tr}
	r.obs.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "factory/a-a1", LastPush: t0})
	b, err := r.c.Board(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(b.Slots) != 1 || b.Slots[0].Phase != api.PhaseRunning {
		t.Fatalf("board = %+v", b.Slots)
	}
}

type readyOnly struct{ listTracker }

func (readyOnly) Active() {} // hides api.Lister: the signature no longer matches

// Symphony 13.5: usage feeds the meter; 80 percent steers once, 100 percent stops.
func TestBudgetSteersThenStops(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{Ticket: api.Budget{Tokens: 100}}, tkt("a", 0))
	get := collect(t, r.c)
	ctx := context.Background()
	if err := r.c.Dispatch(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	r.disp.UsageBy["a-a1"] = api.Usage{InputTokens: 85}
	r.c.Tick(ctx)
	r.c.Tick(ctx)
	if len(r.disp.Steers) != 1 {
		t.Fatalf("steers = %v, want one", r.disp.Steers)
	}
	r.disp.UsageBy["a-a1"] = api.Usage{InputTokens: 100}
	r.c.Tick(ctx)
	if len(r.disp.Cancels) != 1 || r.tr.Phases["a"] != api.PhaseNeedsHuman {
		t.Fatalf("cancels = %v phase = %s", r.disp.Cancels, r.tr.Phases["a"])
	}
	want := []string{"dispatched:a", "budget:a", "budget:a", "needs_human:a"}
	if got := kinds(get()); !eq(got, want) {
		t.Fatalf("events = %v, want %v", got, want)
	}
}

// The loop steers a stalled session and reports it as stalled, not as an operator steer.
func TestStallEmitsStalled(t *testing.T) {
	r := newRig(t, 1, meter.Budgets{}, tkt("a", 0))
	r.c.cfg.Reconcile.StallAfter = 10 * time.Minute
	get := collect(t, r.c)
	ctx := context.Background()
	r.c.Tick(ctx)
	r.clk.advance(11 * time.Minute)
	r.c.Tick(ctx)
	if got := kinds(get()); !eq(got, []string{"dispatched:a", "stalled:a"}) {
		t.Fatalf("events = %v", got)
	}
}

func TestNewValidatesDeps(t *testing.T) {
	r := newRig(t, 1, meter.Budgets{})
	full := Deps{Tracker: r.tr, Dispatcher: r.disp, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk}
	tests := []struct {
		name string
		mut  func(*Deps)
		ok   bool
	}{
		{"complete", func(*Deps) {}, true},
		{"default clock", func(d *Deps) { d.Clock = nil }, true},
		{"no tracker", func(d *Deps) { d.Tracker = nil }, false},
		{"no dispatcher", func(d *Deps) { d.Dispatcher = nil }, false},
		{"no observer", func(d *Deps) { d.Observer = nil }, false},
		{"no store", func(d *Deps) { d.Store = nil }, false},
		{"no meter", func(d *Deps) { d.Meter = nil }, false},
		{"no queue", func(d *Deps) { d.Queue = nil }, false},
	}
	for _, tc := range tests {
		d := full
		tc.mut(&d)
		if _, err := New(d, Config{}); (err == nil) != tc.ok {
			t.Errorf("%s: err = %v, want ok=%v", tc.name, err, tc.ok)
		}
	}
}

// Symphony 14.3: a dispatch that was logged but never pushed is not dispatched again after a restart.
func TestRestartReplaysStepLog(t *testing.T) {
	r := newRig(t, 2, meter.Budgets{}, tkt("a", 0))
	r.tr.Phases["a"] = api.PhaseRunning
	lg, err := eventlog.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	a := tkt("a", 0)
	if err := lg.Append("a", eventlog.Event{Kind: eventlog.KindDispatch, Time: t0, Ticket: &a, Attempt: 1,
		Session: &api.Session{Key: "a-a1", Ticket: "a", Attempt: 1}}); err != nil {
		t.Fatal(err)
	}
	c, err := New(Deps{Tracker: r.tr, Dispatcher: r.disp, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk, Log: lg},
		Config{Reconcile: reconcile.Config{Tick: 30 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	c.Tick(context.Background())
	if len(r.disp.Sessions) != 0 {
		t.Fatalf("logged dispatch was repeated: %v", r.disp.Sessions)
	}
	if b, _ := c.Board(context.Background()); len(b.Slots) != 1 || b.Slots[0].Phase != api.PhaseRunning {
		t.Fatalf("board %+v", b.Slots)
	}
}
