package conformance

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/reconcile"
)

var t0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func tk(id string, prio int, created time.Time, files ...string) api.Ticket {
	return api.Ticket{ID: api.TicketID(id), Repo: "o/r", Title: "t " + id, Priority: prio, CreatedAt: created, Files: files}
}

// log records every port call in order, so tests assert from what happened.
type log struct {
	mu    sync.Mutex
	calls []string
}

func (l *log) add(format string, a ...any) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = append(l.calls, fmt.Sprintf(format, a...))
}

func (l *log) all() []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]string(nil), l.calls...)
}

// index returns the position of the first call with the prefix at or after from, or -1.
func (l *log) index(prefix string, from int) int {
	for i, c := range l.all() {
		if i >= from && strings.HasPrefix(c, prefix) {
			return i
		}
	}
	return -1
}

func (l *log) last(prefix string) int {
	at := -1
	for i, c := range l.all() {
		if strings.HasPrefix(c, prefix) {
			at = i
		}
	}
	return at
}

func (l *log) count(prefix string) int {
	n := 0
	for _, c := range l.all() {
		if strings.HasPrefix(c, prefix) {
			n++
		}
	}
	return n
}

func (l *log) reset() {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.calls = nil
}

// tracker lists every unfinished ticket from Ready, as a real tracker's
// ready-or-in-progress query does, and can be made to fail.
type tracker struct {
	*porttest.Tracker
	l   *log
	err error
}

func (t *tracker) Ready(context.Context) ([]api.Ticket, error) {
	t.l.add("tracker.Ready")
	if t.err != nil {
		return nil, t.err
	}
	var out []api.Ticket
	for id, x := range t.Tickets {
		switch t.Phases[id] {
		case api.PhaseReady, api.PhaseClaimed, api.PhaseRunning, api.PhaseRetryQueue, api.PhaseStalled:
			out = append(out, x)
		}
	}
	return out, nil
}

func (t *tracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	t.l.add("tracker.SetPhase %s %s", id, p)
	return t.Tracker.SetPhase(ctx, id, p)
}

func (t *tracker) Comment(ctx context.Context, id api.TicketID, body string) error {
	t.l.add("tracker.Comment %s", id)
	return t.Tracker.Comment(ctx, id, body)
}

type observer struct {
	*porttest.Observer
	l   *log
	err error
}

func (o *observer) Observe(ctx context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	o.l.add("observer.Observe %s a%d", id, attempt)
	if o.err != nil {
		return api.Observation{}, o.err
	}
	return o.Observer.Observe(ctx, id, attempt)
}

type dispatcher struct {
	*porttest.Dispatcher
	l *log
}

func (d *dispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	d.l.add("dispatcher.Dispatch %s a%d", b.Ticket, b.Attempt)
	return d.Dispatcher.Dispatch(ctx, b)
}

func (d *dispatcher) Steer(ctx context.Context, s api.Session, m string) error {
	d.l.add("dispatcher.Steer %s", s.Key)
	return d.Dispatcher.Steer(ctx, s, m)
}

func (d *dispatcher) Cancel(ctx context.Context, s api.Session) error {
	d.l.add("dispatcher.Cancel %s", s.Key)
	return d.Dispatcher.Cancel(ctx, s)
}

// world is one scheduler wired to recording fakes and a fake clock.
type world struct {
	t     *testing.T
	l     *log
	now   time.Time
	tr    *tracker
	ob    *observer
	dp    *dispatcher
	cfg   reconcile.Config
	state *reconcile.State
	errs  []error
}

func newWorld(t *testing.T, cfg reconcile.Config, ts ...api.Ticket) *world {
	t.Helper()
	l := &log{}
	return &world{
		t: t, l: l, now: t0, cfg: cfg,
		tr: &tracker{Tracker: porttest.NewTracker(ts...), l: l},
		ob: &observer{Observer: porttest.NewObserver(), l: l},
		dp: &dispatcher{Dispatcher: porttest.NewDispatcher(100), l: l},
	}
}

func (w *world) deps() reconcile.Deps {
	return reconcile.Deps{
		Dispatcher: w.dp, Tracker: w.tr, Observer: w.ob,
		Now:     func() time.Time { return w.now },
		OnError: func(err error) { w.errs = append(w.errs, err) },
	}
}

func (w *world) tick() { reconcile.Tick(context.Background(), w.deps(), &w.state, w.cfg) }

func (w *world) advance(d time.Duration) { w.now = w.now.Add(d) }

func (w *world) entry(id string) (reconcile.Entry, bool) {
	e, ok := w.state.Entries[api.TicketID(id)]
	return e, ok
}

var errBoom = errors.New("boom")
