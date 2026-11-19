package core

import (
	"context"
	"fmt"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
)

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
