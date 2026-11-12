package reconcile

import (
	"context"
	"errors"
	"fmt"
	"math"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
	"github.com/KaaS-team/factory/internal/pick"
	"github.com/KaaS-team/factory/internal/reconcile/eventlog"
)

// Deps are the ports and hooks Tick uses. Now and OnError may be nil.
type Deps struct {
	Dispatcher   api.Dispatcher
	Tracker      api.Tracker
	Observer     api.Observer
	Now          func() time.Time
	OnError      func(error)
	InitialLocks pick.Locks      // Locks for the state Tick builds on a fresh start
	Log          *eventlog.Store // append-only step log replayed on a fresh start; nil keeps none
}

// logStep records a completed step; a write error is reported and the tick goes on.
func (d Deps) logStep(id api.TicketID, ev eventlog.Event) {
	if d.Log == nil {
		return
	}
	if ev.Time.IsZero() {
		ev.Time = d.now()
	}
	d.report(d.Log.Append(id, ev))
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
	now := d.now()
	if err != nil {
		d.report(err)
		if *sp == nil {
			return // nothing to reconcile and no candidates
		}
	} else if *sp == nil {
		*sp = recoverState(ctx, d, ready, cfg, now)
		(*sp).Locks = d.InitialLocks
	}
	s := *sp
	if ctx.Err() != nil {
		return
	}
	// Symphony 8.1: running work is reconciled first. When Ready fails, stall and terminal
	// checks run from the stored state and only new dispatch is skipped.
	s.noDispatch = err != nil
	if err == nil {
		// The Ready list must include claimed and running tickets (core merges in Lister.Active);
		// a ticket missing from it is marked terminal and its session cancelled.
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
	s.Unobserved = map[api.TicketID]bool{}
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
			s.Unobserved[id] = true // keep LastObs; no stall decision this tick (Symphony 8.5)
			continue
		}
		e.LastObs = o
		s.Entries[id] = e
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
	d.Restore(s, ready)
	return s
}

// Restore replays the step log over s for the listed active tickets. The log knows steps the observer
// cannot see (a dispatch before the first push, a queued retry), so it wins unless the observer found
// a newer attempt. A log that failed its checksum is rebuilt and the audit goes to OnError.
func (d Deps) Restore(s *State, active []api.Ticket) {
	if d.Log == nil {
		return
	}
	logged, audits, err := d.Log.Replay()
	d.report(err)
	for _, a := range audits {
		d.report(errors.New(a))
	}
	for _, t := range active {
		if l, ok := logged[t.ID]; ok && l.Attempt >= s.Entries[t.ID].Attempt {
			s.Entries[t.ID] = Entry{Ticket: t, Phase: l.Phase, Attempt: l.Attempt, Session: l.Session,
				StartedAt: l.StartedAt, SteeredAt: l.SteeredAt, RetryAt: l.RetryAt, Error: l.Error}
		}
	}
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
		d.logStep(a.ID, eventlog.Event{Kind: eventlog.KindSteer, Time: now})
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
		e.Phase, e.RetryAt, e.Session, e.SteeredAt, e.Error = api.PhaseRetryQueue, a.At, nil, time.Time{}, a.Reason
		s.Entries[a.ID] = e
		d.logStep(a.ID, eventlog.Event{Kind: eventlog.KindRetry, Time: now, Ticket: &e.Ticket, Attempt: e.Attempt, At: a.At, Reason: a.Reason})
	case Requeue:
		e.Error = a.Reason
		s.Entries[a.ID] = e
	case Cancel:
		if cancelEntry(ctx, d, s, e, a) {
			d.logStep(a.ID, eventlog.Event{Kind: eventlog.KindEnd, Time: now, Reason: a.Reason})
		}
	case MarkDone:
		if err := d.Tracker.SetPhase(ctx, a.ID, api.PhaseDone); err != nil {
			d.report(err)
			return
		}
		delete(s.Entries, a.ID)
		d.logStep(a.ID, eventlog.Event{Kind: eventlog.KindEnd, Time: now, Reason: string(MarkDone)})
	case NeedsHuman:
		if err := d.Dispatcher.Cancel(ctx, sessionOf(d, e)); err != nil {
			d.report(err)
			return
		}
		escalate(ctx, d, s, a.ID, a.Reason, now)
	}
}

// cancelEntry reports whether the entry was removed.
func cancelEntry(ctx context.Context, d Deps, s *State, e Entry, a Action) bool {
	if holdsSlot(e.Phase) {
		if err := d.Dispatcher.Cancel(ctx, sessionOf(d, e)); err != nil {
			d.report(err)
			return false
		}
	}
	// A terminal ticket already has its final phase in the tracker; only an operator cancel writes one.
	if a.Reason == "canceled" {
		if ctx.Err() != nil {
			return false
		}
		if err := d.Tracker.SetPhase(ctx, a.ID, api.PhaseCanceled); err != nil {
			d.report(err)
			return false
		}
	}
	delete(s.Entries, a.ID)
	delete(s.CancelRequested, a.ID)
	return true
}

func escalate(ctx context.Context, d Deps, s *State, id api.TicketID, reason string, now time.Time) {
	if ctx.Err() != nil {
		return
	}
	if err := d.Tracker.SetPhase(ctx, id, api.PhaseNeedsHuman); err != nil {
		d.report(err)
		return
	}
	delete(s.Entries, id)
	d.logStep(id, eventlog.Event{Kind: eventlog.KindEnd, Time: now, Reason: string(NeedsHuman)})
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
	name, err := brief.Name(t.ID, a.Attempt)
	var sess api.Session
	if err == nil {
		sess, err = d.Dispatcher.Dispatch(ctx, api.Brief{
			Ticket: t.ID, Attempt: a.Attempt, Name: name,
			Text: t.Title + "\n\n" + t.Body, Repo: t.Repo, Base: cfg.Base,
			Branch: fmt.Sprintf("factory/%s-a%d", t.ID, a.Attempt), Workflow: t.Workflow,
		})
	}
	if err != nil {
		d.report(err)
		if ctx.Err() != nil {
			return
		}
		if a.Attempt >= cfg.MaxAttempts {
			escalate(ctx, d, s, a.ID, fmt.Sprintf("dispatch failed after %d attempts", a.Attempt), now)
			return
		}
		if d.Tracker.SetPhase(ctx, a.ID, api.PhaseRetryQueue) == nil {
			e := Entry{Ticket: t, Phase: api.PhaseRetryQueue, Attempt: a.Attempt, RetryAt: now.Add(cfg.Backoff(a.Attempt)), Error: err.Error()}
			s.Entries[a.ID] = e
			d.logStep(a.ID, eventlog.Event{Kind: eventlog.KindRetry, Time: now, Ticket: &t, Attempt: a.Attempt, At: e.RetryAt, Reason: e.Error})
		}
		return
	}
	s.fired = append(s.fired, now)
	s.Entries[a.ID] = Entry{Ticket: t, Phase: api.PhaseRunning, Attempt: a.Attempt, Session: &sess, StartedAt: now}
	d.logStep(a.ID, eventlog.Event{Kind: eventlog.KindDispatch, Time: now, Ticket: &t, Attempt: a.Attempt, Session: &sess})
	if ctx.Err() != nil {
		return
	}
	d.report(d.Tracker.SetPhase(ctx, a.ID, api.PhaseRunning))
}
