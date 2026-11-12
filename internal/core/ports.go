package core

import (
	"context"

	"github.com/KaaS-team/factory/internal/api"
)

// The loop reaches the ports through these wrappers, so each decision the
// reconcile package applies is also published as an event. Operator calls in
// control.go use the raw ports and publish their own event. Reconcile runs
// inside Tick with c.mu held.

type loopDispatcher struct{ c *Core }

func (l loopDispatcher) Name() string   { return l.c.d.Dispatcher.Name() }
func (l loopDispatcher) Caps() api.Caps { return l.c.d.Dispatcher.Caps() }

func (l loopDispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	s, err := l.c.d.Dispatcher.Dispatch(ctx, b)
	if err != nil {
		return s, err
	}
	l.c.sessions[b.Ticket] = s
	l.c.attempts[b.Ticket] = max(l.c.attempts[b.Ticket], b.Attempt)
	delete(l.c.warned, b.Ticket)
	l.c.hub.emit(KindDispatched, b.Ticket, map[string]any{"attempt": b.Attempt, "session": s.Key})
	return s, nil
}

func (l loopDispatcher) Steer(ctx context.Context, s api.Session, msg string) error {
	if err := l.c.d.Dispatcher.Steer(ctx, s, msg); err != nil {
		return err
	}
	l.c.hub.emit(KindStalled, s.Ticket, map[string]any{"message": msg})
	return nil
}

func (l loopDispatcher) Cancel(ctx context.Context, s api.Session) error {
	return l.c.d.Dispatcher.Cancel(ctx, s)
}

func (l loopDispatcher) Usage(ctx context.Context, s api.Session) (api.Usage, error) {
	return l.c.d.Dispatcher.Usage(ctx, s)
}

type loopTracker struct{ c *Core }

func (l loopTracker) Name() string { return l.c.d.Tracker.Name() }

// Ready lists unfinished tickets: the tracker's ready tickets plus, when it
// implements api.Lister, the ones already claimed, so running work is not
// mistaken for finished work.
func (l loopTracker) Ready(ctx context.Context) ([]api.Ticket, error) {
	ts, err := l.c.d.Tracker.Ready(ctx)
	if err != nil {
		return nil, err
	}
	if lister, ok := l.c.d.Tracker.(api.Lister); ok {
		active, err := lister.Active(ctx)
		if err != nil {
			return nil, err
		}
		seen := map[api.TicketID]bool{}
		for _, t := range ts {
			seen[t.ID] = true
		}
		for _, t := range active {
			if !seen[t.ID] {
				ts = append(ts, t)
			}
		}
	}
	for _, t := range ts {
		l.c.report(l.c.d.Store.PutTicket(ctx, t))
	}
	return ts, nil
}

func (l loopTracker) Get(ctx context.Context, id api.TicketID) (api.Ticket, error) {
	return l.c.d.Tracker.Get(ctx, id)
}

func (l loopTracker) Comment(ctx context.Context, id api.TicketID, body string) error {
	return l.c.d.Tracker.Comment(ctx, id, body)
}

func (l loopTracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	switch p {
	case api.PhaseDone:
		// Queue and merge first: the slot frees only once the PR has landed.
		if err := l.c.d.Tracker.SetPhase(ctx, id, p); err != nil {
			return err
		}
		l.c.finish(ctx, id)
		return nil
	case api.PhaseRetryQueue:
		if err := l.c.d.Tracker.SetPhase(ctx, id, p); err != nil {
			return err
		}
		l.c.hub.emit(KindRetried, id, map[string]any{"attempt": l.c.attempts[id] + 1})
		return nil
	case api.PhaseNeedsHuman:
		if err := l.c.d.Tracker.SetPhase(ctx, id, p); err != nil {
			return err
		}
		l.c.hub.emit(KindNeedsHuman, id, nil)
		return nil
	}
	return l.c.d.Tracker.SetPhase(ctx, id, p)
}

type loopObserver struct{ c *Core }

func (l loopObserver) Observe(ctx context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	o, err := l.c.d.Observer.Observe(ctx, id, attempt)
	if err != nil {
		return o, err
	}
	l.c.lastObs[id] = o
	l.c.report(l.c.d.Store.Apply(ctx, o))
	if o.Attempt == attempt && o.Branch != "" && o.LastPush.After(l.c.lastPush[id]) {
		l.c.lastPush[id] = o.LastPush
		l.c.hub.emit(KindPushed, id, map[string]any{"attempt": attempt, "branch": o.Branch})
	}
	return o, nil
}
