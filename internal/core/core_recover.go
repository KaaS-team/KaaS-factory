package core

import (
	"context"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// with no saved position is left alone: it was not parked by a workflow node.
func (c *Core) restoreStage(ctx context.Context, t api.Ticket) *stageRun {
	if c.d.Stages == nil {
		return nil
	}
	if c.parked[t.ID] {
		if _, ok := c.savedPosition(ctx, t.ID); !ok {
			return nil
		}
	}
	st, err := c.stageOf(ctx, t.ID, t.Workflow)
	c.report(err)
	return st
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
	if p, ok := c.d.Tracker.(observe.Parker); ok {
		parked, err := p.Parked(ctx)
		c.report(err)
		for _, t := range parked {
			c.parked[t.ID] = true
			c.tickets[t.ID] = t
			c.restoreStage(ctx, t)
		}
	}
	s := &reconcile.State{Entries: map[api.TicketID]reconcile.Entry{}}
	for _, t := range tickets {
		base := 0 // attempts the finished nodes used; the observer counts attempts across nodes
		if st := c.restoreStage(ctx, t); st != nil {
			base = st.base
		}
		for n := c.cfg.Reconcile.MaxAttempts; n >= 1; n-- {
			o, err := c.d.Observer.Observe(ctx, t.ID, base+n)
			if err != nil {
				c.report(err)
				break
			}
			if o.Attempt == base+n && o.Branch != "" {
				started := o.LastPush
				if started.IsZero() {
					started = c.d.Clock.Now()
				}
				s.Entries[t.ID] = reconcile.Entry{Ticket: t, Phase: api.PhaseRunning, Attempt: n, StartedAt: started}
				c.attempts[t.ID] = base + n
				c.lastPush[t.ID] = o.LastPush
				break
			}
		}
	}
	c.reconcileDeps().Restore(s, tickets)
	for id, e := range s.Entries {
		c.attempts[id] = max(c.attempts[id], e.Attempt)
	}
	c.state, c.started = s, true
}
