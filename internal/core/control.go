package core

import (
	"context"
	"fmt"
	"sort"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// Board returns the whole orchestrator state: claimed tickets, ready ones and the merge queue.
func (c *Core) Board(ctx context.Context) (api.Board, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recover(ctx)
	b := api.Board{Slots: []api.Slot{}, Ready: []api.Ticket{}, MergeQueue: []api.TicketID{}, FiresLeft: c.firesLeft()}
	if c.state == nil {
		return b, ctx.Err()
	}
	for _, e := range c.state.Entries {
		sl := api.Slot{Ticket: e.Ticket, Phase: e.Phase, Budget: c.cfg.Budget, LastPush: c.lastPush[e.Ticket.ID]}
		if holdsSlot(e.Phase) {
			s := c.sessionOf(e)
			sl.Session = &s
			sl.Usage = c.d.Meter.Used(c.meterKey(e.Ticket.ID, s)).Ticket
		}
		b.Slots = append(b.Slots, sl)
	}
	sort.Slice(b.Slots, func(i, j int) bool { return b.Slots[i].Ticket.ID < b.Slots[j].Ticket.ID })
	for _, t := range c.state.Ready {
		if _, tracked := c.state.Entries[t.ID]; !tracked {
			b.Ready = append(b.Ready, t)
		}
	}
	q, err := c.d.Queue.Queued(ctx)
	if err != nil {
		return b, fmt.Errorf("merge queue: %w", err)
	}
	for _, e := range q {
		b.MergeQueue = append(b.MergeQueue, api.TicketID(e.ID))
	}
	return b, nil
}

func (c *Core) firesLeft() int {
	caps := c.d.Dispatcher.Caps()
	if caps.FiresPerHour <= 0 {
		return -1
	}
	return caps.FiresPerHour
}

// start claims a ticket, dispatches the given attempt and records it as running.
func (c *Core) start(ctx context.Context, t api.Ticket, attempt int) (api.Session, error) {
	if err := c.d.Tracker.SetPhase(ctx, t.ID, api.PhaseClaimed); err != nil {
		return api.Session{}, err
	}
	s, err := c.d.Dispatcher.Dispatch(ctx, api.Brief{
		Ticket: t.ID, Attempt: attempt, Name: fmt.Sprintf("%s-a%d.md", t.ID, attempt),
		Text: t.Title + "\n\n" + t.Body, Repo: t.Repo, Base: c.cfg.Reconcile.Base,
		Branch: fmt.Sprintf("factory/%s-a%d", t.ID, attempt), Workflow: t.Workflow, Budget: c.cfg.Budget,
	})
	if err != nil {
		return s, err
	}
	c.state.Entries[t.ID] = reconcile.Entry{Ticket: t, Phase: api.PhaseRunning, Attempt: attempt, Session: &s, StartedAt: c.d.Clock.Now()}
	c.sessions[t.ID] = s
	c.attempts[t.ID] = max(c.attempts[t.ID], attempt)
	delete(c.warned, t.ID)
	c.report(c.d.Tracker.SetPhase(ctx, t.ID, api.PhaseRunning))
	delete(c.parked, t.ID)
	return s, nil
}

// Dispatch starts attempt 1 of a ticket now, whatever the slot count.
func (c *Core) Dispatch(ctx context.Context, id api.TicketID) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recover(ctx)
	if _, ok := c.state.Entries[id]; ok {
		return fmt.Errorf("ticket %s is already running", id)
	}
	t, err := c.d.Tracker.Get(ctx, id)
	if err != nil {
		return err
	}
	attempt := c.attempts[id] + 1
	s, err := c.start(ctx, t, attempt)
	if err != nil {
		return err
	}
	c.hub.emit(KindDispatched, id, map[string]any{"attempt": attempt, "session": s.Key})
	return nil
}

// Steer sends a message to a running ticket's session.
func (c *Core) Steer(ctx context.Context, id api.TicketID, message string) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recover(ctx)
	e, ok := c.state.Entries[id]
	if !ok || !holdsSlot(e.Phase) {
		return fmt.Errorf("ticket %s has no running session", id)
	}
	if err := c.d.Dispatcher.Steer(ctx, c.sessionOf(e), message); err != nil {
		return err
	}
	c.hub.emit(KindSteered, id, map[string]any{"message": message})
	return nil
}

// Cancel stops a ticket's session and marks the ticket canceled.
func (c *Core) Cancel(ctx context.Context, id api.TicketID) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recover(ctx)
	return c.cancel(ctx, id)
}

// cancel is Cancel with c.mu held.
func (c *Core) cancel(ctx context.Context, id api.TicketID) error {
	e, ok := c.state.Entries[id]
	if !ok {
		return fmt.Errorf("ticket %s is not tracked", id)
	}
	if holdsSlot(e.Phase) {
		if err := c.d.Dispatcher.Cancel(ctx, c.sessionOf(e)); err != nil {
			return err
		}
	}
	if err := c.d.Tracker.SetPhase(ctx, id, api.PhaseCanceled); err != nil {
		return err
	}
	delete(c.state.Entries, id)
	c.hub.emit(KindCanceled, id, map[string]any{"attempt": e.Attempt})
	return nil
}

// Retry stops the current session, if any, and starts the next attempt now.
// It also revives a ticket the loop gave up on, from the last attempt it used.
func (c *Core) Retry(ctx context.Context, id api.TicketID) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.recover(ctx)
	return c.retry(ctx, id)
}

// retry is Retry with c.mu held.
func (c *Core) retry(ctx context.Context, id api.TicketID) error {
	e, tracked := c.state.Entries[id]
	t := e.Ticket
	last := c.attempts[id]
	if tracked {
		last = max(last, e.Attempt)
		if holdsSlot(e.Phase) {
			if err := c.d.Dispatcher.Cancel(ctx, c.sessionOf(e)); err != nil {
				return err
			}
		}
	} else {
		var err error
		if t, err = c.d.Tracker.Get(ctx, id); err != nil {
			return err
		}
		if last == 0 {
			if lo, ok := c.d.Observer.(api.LatestObserver); ok {
				o, err := lo.Latest(ctx, id)
				if err != nil {
					return err
				}
				last = o.Attempt
			}
		}
	}
	attempt := last + 1
	if _, err := c.start(ctx, t, attempt); err != nil {
		return err
	}
	c.hub.emit(KindRetried, id, map[string]any{"attempt": attempt, "manual": true})
	return nil
}
