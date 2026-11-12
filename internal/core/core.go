// Package core is the one api.Control: it owns a single reconcile loop, turns
// the loop's decisions into calls on the ports, and publishes every change as
// an api.Event (Symphony 7, 8.1 and 13). It holds no package-level state.
package core

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// Clock is the time source of the loop.
type Clock interface {
	Now() time.Time
	// After returns a channel that receives once d has passed.
	After(d time.Duration) <-chan time.Time
}

// RealClock is the wall clock.
type RealClock struct{}

// Now returns the current time.
func (RealClock) Now() time.Time { return time.Now() }

// After waits on the wall clock.
func (RealClock) After(d time.Duration) <-chan time.Time { return time.After(d) }

// Store is the cache the loop keeps current; *store.Store implements it.
type Store interface {
	PutTicket(ctx context.Context, t api.Ticket) error
	Apply(ctx context.Context, o api.Observation) error
}

// MergeQueue is the merge queue the loop feeds. A mergeq.Runner over the
// tracker's PR state implements Run and Queued; Enqueue records a finished ticket's PR.
type MergeQueue interface {
	Enqueue(ctx context.Context, id api.TicketID, pr int) error
	Queued(ctx context.Context) ([]mergeq.Entry, error)
	Run(ctx context.Context) (mergeq.Report, error)
}

// Deps are everything a Core talks to. All but Clock are required.
type Deps struct {
	Tracker    api.Tracker
	Dispatcher api.Dispatcher
	Observer   api.Observer
	Store      Store
	Meter      *meter.Meter
	Queue      MergeQueue
	Stages     *Stages // nil runs each ticket as one session
	Clock      Clock   // RealClock when nil
	OnError    func(error)
}

// Config holds the loop settings.
type Config struct {
	Reconcile   reconcile.Config
	Team        string     // meter key team
	Budget      api.Budget // per-ticket cap shown on the board
	EventBuffer int        // events a subscriber may fall behind by before it is dropped (64)
}

// Core implements api.Control.
type Core struct {
	d   Deps
	cfg Config
	hub *hub

	mu       sync.Mutex // guards everything below; held for a whole tick
	state    *reconcile.State
	started  bool
	attempts map[api.TicketID]int // highest attempt dispatched, kept across needs-human
	lastPush map[api.TicketID]time.Time
	lastObs  map[api.TicketID]api.Observation
	sessions map[api.TicketID]api.Session
	warned   map[api.TicketID]bool // budget steer already sent
	stages   map[api.TicketID]*stageRun
	tickets  map[api.TicketID]api.Ticket // last read of each ticket, for prompt templates
}

var _ api.Control = (*Core)(nil)

// New returns a Core over the given ports.
func New(d Deps, cfg Config) (*Core, error) {
	switch {
	case d.Tracker == nil:
		return nil, errors.New("core: Deps.Tracker is required")
	case d.Dispatcher == nil:
		return nil, errors.New("core: Deps.Dispatcher is required")
	case d.Observer == nil:
		return nil, errors.New("core: Deps.Observer is required")
	case d.Store == nil:
		return nil, errors.New("core: Deps.Store is required")
	case d.Meter == nil:
		return nil, errors.New("core: Deps.Meter is required")
	case d.Queue == nil:
		return nil, errors.New("core: Deps.Queue is required")
	}
	if d.Clock == nil {
		d.Clock = RealClock{}
	}
	if cfg.EventBuffer <= 0 {
		cfg.EventBuffer = 64
	}
	if cfg.Reconcile.Tick <= 0 {
		cfg.Reconcile.Tick = 30 * time.Second
	}
	if cfg.Reconcile.Base == "" {
		cfg.Reconcile.Base = "main"
	}
	if cfg.Reconcile.MaxAttempts <= 0 {
		cfg.Reconcile.MaxAttempts = 3
	}
	return &Core{
		d: d, cfg: cfg, hub: newHub(cfg.EventBuffer, d.Clock.Now),
		attempts: map[api.TicketID]int{}, lastPush: map[api.TicketID]time.Time{},
		lastObs: map[api.TicketID]api.Observation{}, sessions: map[api.TicketID]api.Session{},
		warned: map[api.TicketID]bool{}, stages: map[api.TicketID]*stageRun{}, tickets: map[api.TicketID]api.Ticket{},
	}, nil
}

func (c *Core) report(err error) {
	if err != nil && c.d.OnError != nil {
		c.d.OnError(err)
	}
}

// Run ticks immediately and then every configured interval until ctx ends, and returns ctx.Err().
func (c *Core) Run(ctx context.Context) error {
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		c.Tick(ctx)
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-c.d.Clock.After(c.cfg.Reconcile.Tick):
		}
	}
}

// Tick runs one pass in Symphony 8.1 order: reconcile running work (usage and
// budgets, then stalls and completion), preflight, fetch and rank candidates,
// dispatch while slots remain, then publish a tick event.
func (c *Core) Tick(ctx context.Context) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if ctx.Err() != nil {
		return
	}
	c.recover(ctx)
	c.meterPass(ctx)
	reconcile.Tick(ctx, c.reconcileDeps(), &c.state, c.cfg.Reconcile)
	if ctx.Err() != nil {
		return
	}
	queued, _ := c.d.Queue.Queued(ctx)
	running, ready := 0, 0
	for _, e := range c.state.Entries {
		if e.Phase != api.PhaseRetryQueue {
			running++
		}
	}
	ready = len(c.state.Ready) - len(c.state.Entries)
	c.hub.emit(KindTick, "", map[string]any{"slots": running, "ready": max(ready, 0), "queued": len(queued)})
}

// recover builds the running set once: from the tracker's Active list when it
// has one, otherwise from Ready (Symphony 14.3). A ticket with a work branch
// for some attempt is running that attempt.
func (c *Core) recover(ctx context.Context) {
	if c.started || ctx.Err() != nil {
		return
	}
	var tickets []api.Ticket
	var err error
	if l, ok := c.d.Tracker.(api.Lister); ok {
		tickets, err = l.Active(ctx)
	} else {
		tickets, err = c.d.Tracker.Ready(ctx)
	}
	if err != nil {
		c.report(err)
		return
	}
	s := &reconcile.State{Entries: map[api.TicketID]reconcile.Entry{}}
	for _, t := range tickets {
		for n := c.cfg.Reconcile.MaxAttempts; n >= 1; n-- {
			o, err := c.d.Observer.Observe(ctx, t.ID, n)
			if err != nil {
				c.report(err)
				break
			}
			if o.Attempt == n && o.Branch != "" {
				started := o.LastPush
				if started.IsZero() {
					started = c.d.Clock.Now()
				}
				s.Entries[t.ID] = reconcile.Entry{Ticket: t, Phase: api.PhaseRunning, Attempt: n, StartedAt: started}
				c.attempts[t.ID] = n
				c.lastPush[t.ID] = o.LastPush
				break
			}
		}
	}
	c.state, c.started = s, true
}

func (c *Core) reconcileDeps() reconcile.Deps {
	return reconcile.Deps{
		Dispatcher: loopDispatcher{c}, Tracker: loopTracker{c}, Observer: loopObserver{c},
		Now: c.d.Clock.Now, OnError: c.d.OnError,
	}
}

func (c *Core) meterKey(id api.TicketID, s api.Session) meter.Key {
	return meter.Key{Team: c.cfg.Team, Ticket: id, Session: s.Key}
}

func (c *Core) sessionOf(e reconcile.Entry) api.Session {
	if e.Session != nil {
		return *e.Session
	}
	if s, ok := c.sessions[e.Ticket.ID]; ok && s.Attempt == e.Attempt {
		return s
	}
	return api.Session{Key: fmt.Sprintf("%s-a%d", e.Ticket.ID, e.Attempt), Ticket: e.Ticket.ID, Attempt: e.Attempt, Dispatcher: c.d.Dispatcher.Name()}
}

func holdsSlot(p api.Phase) bool {
	return p == api.PhaseClaimed || p == api.PhaseRunning || p == api.PhaseStalled
}

// meterPass records each running session's usage and applies the meter's verdict (Symphony 13.5).
func (c *Core) meterPass(ctx context.Context) {
	for id, e := range c.state.Entries {
		if !holdsSlot(e.Phase) || ctx.Err() != nil {
			continue
		}
		sess := c.sessionOf(e)
		u, err := c.d.Dispatcher.Usage(ctx, sess)
		if err != nil {
			c.report(err)
			continue
		}
		k := c.meterKey(id, sess)
		delta, err := c.d.Meter.Record(k, u)
		if err != nil {
			c.report(err)
			continue
		}
		if th, ok := c.d.Tracker.(meter.Thread); ok {
			c.report(meter.Ledger{Thread: th, Holder: c.cfg.Team}.Add(ctx, id, e.Attempt, u, delta))
		}
		switch c.d.Meter.Check(k) {
		case meter.Steer:
			if c.warned[id] {
				continue
			}
			if err := c.d.Dispatcher.Steer(ctx, sess, "Budget nearly used. Commit and push what you have, then wrap up."); err != nil {
				c.report(err)
				continue
			}
			c.warned[id] = true
			c.hub.emit(KindBudget, id, map[string]any{"verdict": string(meter.Steer)})
		case meter.Stop:
			if err := c.d.Dispatcher.Cancel(ctx, sess); err != nil {
				c.report(err)
				continue
			}
			c.hub.emit(KindBudget, id, map[string]any{"verdict": string(meter.Stop)})
			c.escalate(ctx, id, "budget used")
		}
	}
}

// escalate stops tracking a ticket and marks it for a human.
func (c *Core) escalate(ctx context.Context, id api.TicketID, reason string) {
	if err := c.d.Tracker.SetPhase(ctx, id, api.PhaseNeedsHuman); err != nil {
		c.report(err)
		return
	}
	delete(c.state.Entries, id)
	delete(c.stages, id)
	c.hub.emit(KindNeedsHuman, id, map[string]any{"reason": reason})
	c.report(c.d.Tracker.Comment(ctx, id, "Needs a human: "+reason+"."))
}

// finish queues a finished ticket's PR and runs the merge queue. The slot is
// released only after the pass, so a ticket that waits on a merge keeps its
// place until it lands.
func (c *Core) finish(ctx context.Context, id api.TicketID) {
	pr := c.lastObs[id].PR
	if err := c.d.Queue.Enqueue(ctx, id, pr); err != nil {
		c.report(err)
		return
	}
	c.hub.emit(KindQueued, id, map[string]any{"pr": pr})
	rep, err := c.d.Queue.Run(ctx)
	c.report(err)
	if rep.GateRuns > 0 {
		c.hub.emit(KindGate, "", map[string]any{"runs": rep.GateRuns})
	}
	for _, l := range rep.Landed {
		lid := api.TicketID(l)
		if err := c.d.Tracker.SetPhase(ctx, lid, api.PhaseMerged); err != nil {
			c.report(err)
		}
		c.hub.emit(KindMerged, lid, map[string]any{"pr": c.lastObs[lid].PR})
	}
	for _, ej := range rep.Ejected {
		eid := api.TicketID(ej.ID)
		if err := c.d.Tracker.SetPhase(ctx, eid, api.PhaseNeedsHuman); err != nil {
			c.report(err)
		}
		c.hub.emit(KindNeedsHuman, eid, map[string]any{"reason": "gate failed"})
		c.report(c.d.Tracker.Comment(ctx, eid, "Needs a human: gate failed.\n\n"+ej.LogTail))
	}
}

// Events subscribes to the event stream. The channel closes when ctx ends or
// when the subscriber falls EventBuffer events behind.
func (c *Core) Events(ctx context.Context) (<-chan api.Event, error) {
	return c.hub.subscribe(ctx), nil
}
