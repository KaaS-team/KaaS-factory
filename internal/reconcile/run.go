package reconcile

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Deps are the ports and hooks Run uses. Now and OnError may be nil.
type Deps struct {
	Dispatcher api.Dispatcher
	Tracker    api.Tracker
	Observer   api.Observer
	Cancels    <-chan api.TicketID // operator cancel requests, read without blocking each tick
	Now        func() time.Time
	OnError    func(error)
}

func (d Deps) now() time.Time {
	if d.Now != nil {
		return d.Now()
	}
	return time.Now()
}

func (d Deps) report(err error) {
	if d.OnError != nil && err != nil {
		d.OnError(err)
	}
}

// Run ticks every cfg.Tick until ctx is cancelled, then returns ctx.Err().
// It makes no port call once ctx is done.
func Run(ctx context.Context, d Deps, cfg Config) error {
	cfg = cfg.withDefaults()
	var s *State
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if s != nil {
			drain(d.Cancels, s)
		}
		Tick(ctx, d, &s, cfg)
		timer := time.NewTimer(cfg.Tick)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func drain(ch <-chan api.TicketID, s *State) {
	for {
		select {
		case id := <-ch:
			if s.CancelRequested == nil {
				s.CancelRequested = map[api.TicketID]bool{}
			}
			s.CancelRequested[id] = true
		default:
			return
		}
	}
}

// Tick runs one pass: read the tracker, observe running tickets, Decide and
// apply. A nil *sp means a fresh process: the state is rebuilt from the
// tracker and observer (Symphony 14.3). Errors go to d.OnError and leave the
// state as it was, so the next tick tries again.
func Tick(ctx context.Context, d Deps, sp **State, cfg Config) {
	cfg = cfg.withDefaults()
	if ctx.Err() != nil {
		return
	}
	ready, err := d.Tracker.Ready(ctx)
	if err != nil {
		d.report(err)
		return
	}
	now := d.now()
	if *sp == nil {
		*sp = recoverState(ctx, d, ready, cfg, now)
	}
	s := *sp
	if ctx.Err() != nil {
		return
	}
	listed := map[api.TicketID]api.Ticket{}
	for _, t := range ready {
		listed[t.ID] = t
	}
	s.Ready = ready
	s.Terminal = map[api.TicketID]bool{}
	for id, e := range s.Entries {
		if t, ok := listed[id]; ok {
			e.Ticket = t
			s.Entries[id] = e
		} else {
			s.Terminal[id] = true
		}
	}
	caps := d.Dispatcher.Caps()
	if cfg.MaxConcurrent <= 0 || (caps.MaxConcurrent > 0 && caps.MaxConcurrent < cfg.MaxConcurrent) {
		cfg.MaxConcurrent = caps.MaxConcurrent
	}
	s.FiresLeft = math.MaxInt32
	if caps.FiresPerHour > 0 {
		s.fired = recent(s.fired, now)
		s.FiresLeft = max(0, caps.FiresPerHour-len(s.fired))
	}
	var obs []api.Observation
	for id, e := range s.Entries {
		if !holdsSlot(e.Phase) || s.Terminal[id] {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		o, err := d.Observer.Observe(ctx, id, e.Attempt)
		if err != nil {
			d.report(err)
			continue
		}
		obs = append(obs, o)
	}
	for _, a := range Decide(*s, obs, now, cfg) {
		if ctx.Err() != nil {
			return
		}
		apply(ctx, d, s, a, now, cfg)
	}
}

func recent(ts []time.Time, now time.Time) []time.Time {
	var out []time.Time
	for _, t := range ts {
		if now.Sub(t) < time.Hour {
			out = append(out, t)
		}
	}
	return out
}

// recoverState rebuilds the running set from the tracker's active tickets and
// the observer: a ticket whose branch for some attempt exists is running that
// attempt. A claimed ticket that never pushed looks ready and is dispatched
// again, which the dispatcher answers with the same session.
func recoverState(ctx context.Context, d Deps, ready []api.Ticket, cfg Config, now time.Time) *State {
	s := newState()
	for _, t := range ready {
		for n := cfg.MaxAttempts; n >= 1; n-- {
			if ctx.Err() != nil {
				return s
			}
			o, err := d.Observer.Observe(ctx, t.ID, n)
			if err != nil {
				d.report(err)
				break
			}
			if o.Attempt == n && o.Branch != "" {
				started := o.LastPush
				if started.IsZero() {
					started = now
				}
				s.Entries[t.ID] = Entry{Ticket: t, Phase: api.PhaseRunning, Attempt: n, StartedAt: started}
				break
			}
		}
	}
	return s
}

func newState() *State { return &State{Entries: map[api.TicketID]Entry{}} }

func sessionOf(d Deps, e Entry) api.Session {
	if e.Session != nil {
		return *e.Session
	}
	return api.Session{
		Key: fmt.Sprintf("%s-a%d", e.Ticket.ID, e.Attempt), Ticket: e.Ticket.ID,
		Attempt: e.Attempt, Dispatcher: d.Dispatcher.Name(),
	}
}

func apply(ctx context.Context, d Deps, s *State, a Action, now time.Time, cfg Config) {
	e := s.Entries[a.ID]
	switch a.Kind {
	case Dispatch:
		dispatch(ctx, d, s, a, now, cfg)
	case Steer:
		if err := d.Dispatcher.Steer(ctx, sessionOf(d, e), a.Message); err != nil {
			d.report(err)
			return
		}
		e.Phase, e.SteeredAt = api.PhaseStalled, now
		s.Entries[a.ID] = e
	case Retry:
		if err := d.Dispatcher.Cancel(ctx, sessionOf(d, e)); err != nil {
			d.report(err)
			return
		}
		if ctx.Err() != nil {
			return
		}
		if err := d.Tracker.SetPhase(ctx, a.ID, api.PhaseRetryQueue); err != nil {
			d.report(err)
			return
		}
		e.Phase, e.RetryAt, e.Session, e.SteeredAt = api.PhaseRetryQueue, a.At, nil, time.Time{}
		s.Entries[a.ID] = e
	case Cancel:
		cancelEntry(ctx, d, s, e, a)
	case MarkDone:
		if err := d.Tracker.SetPhase(ctx, a.ID, api.PhaseDone); err != nil {
			d.report(err)
			return
		}
		delete(s.Entries, a.ID)
	case NeedsHuman:
		if err := d.Dispatcher.Cancel(ctx, sessionOf(d, e)); err != nil {
			d.report(err)
			return
		}
		escalate(ctx, d, s, a.ID, a.Reason)
	}
}

func cancelEntry(ctx context.Context, d Deps, s *State, e Entry, a Action) {
	if holdsSlot(e.Phase) {
		if err := d.Dispatcher.Cancel(ctx, sessionOf(d, e)); err != nil {
			d.report(err)
			return
		}
	}
	// A terminal ticket already has its final phase in the tracker; only an operator cancel writes one.
	if a.Reason == "canceled" {
		if ctx.Err() != nil {
			return
		}
		if err := d.Tracker.SetPhase(ctx, a.ID, api.PhaseCanceled); err != nil {
			d.report(err)
			return
		}
	}
	delete(s.Entries, a.ID)
	delete(s.CancelRequested, a.ID)
}

func escalate(ctx context.Context, d Deps, s *State, id api.TicketID, reason string) {
	if ctx.Err() != nil {
		return
	}
	if err := d.Tracker.SetPhase(ctx, id, api.PhaseNeedsHuman); err != nil {
		d.report(err)
		return
	}
	delete(s.Entries, id)
	if ctx.Err() != nil {
		return
	}
	d.report(d.Tracker.Comment(ctx, id, "Needs a human: "+reason+"."))
}

func dispatch(ctx context.Context, d Deps, s *State, a Action, now time.Time, cfg Config) {
	if err := d.Tracker.SetPhase(ctx, a.ID, api.PhaseClaimed); err != nil {
		d.report(err)
		return
	}
	if ctx.Err() != nil {
		return
	}
	t := a.Ticket
	sess, err := d.Dispatcher.Dispatch(ctx, api.Brief{
		Ticket: t.ID, Attempt: a.Attempt, Name: fmt.Sprintf("%s-a%d.md", t.ID, a.Attempt),
		Text: t.Title + "\n\n" + t.Body, Repo: t.Repo, Base: cfg.Base,
		Branch: fmt.Sprintf("factory/%s-a%d", t.ID, a.Attempt), Workflow: t.Workflow,
	})
	if err != nil {
		d.report(err)
		if ctx.Err() != nil {
			return
		}
		if a.Attempt >= cfg.MaxAttempts {
			escalate(ctx, d, s, a.ID, fmt.Sprintf("dispatch failed after %d attempts", a.Attempt))
			return
		}
		if d.Tracker.SetPhase(ctx, a.ID, api.PhaseRetryQueue) == nil {
			s.Entries[a.ID] = Entry{Ticket: t, Phase: api.PhaseRetryQueue, Attempt: a.Attempt, RetryAt: now.Add(Backoff(a.Attempt))}
		}
		return
	}
	s.fired = append(s.fired, now)
	s.Entries[a.ID] = Entry{Ticket: t, Phase: api.PhaseRunning, Attempt: a.Attempt, Session: &sess, StartedAt: now}
	if ctx.Err() != nil {
		return
	}
	d.report(d.Tracker.SetPhase(ctx, a.ID, api.PhaseRunning))
}
