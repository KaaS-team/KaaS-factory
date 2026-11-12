package core

import (
	"context"
	"sync"

	"github.com/KaaS-team/factory/internal/api"
)

// HistoryLimit is how many events the core keeps per ticket; the oldest are dropped first.
const HistoryLimit = 500

// history is the in-memory per-ticket event log. A restart loses it.
type history struct {
	mu  sync.Mutex
	log map[api.TicketID][]api.Event
}

func newHistory() *history { return &history{log: map[api.TicketID][]api.Event{}} }

// add records an event for its ticket. Events without a ticket are not kept.
func (h *history) add(ev api.Event) {
	if ev.Ticket == "" {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	l := append(h.log[ev.Ticket], ev)
	if len(l) > HistoryLimit {
		l = append([]api.Event(nil), l[len(l)-HistoryLimit:]...)
	}
	h.log[ev.Ticket] = l
}

// History returns a copy of the ticket's last events, oldest first, from the same path that publishes them.
func (c *Core) History(_ context.Context, id api.TicketID) ([]api.Event, error) {
	h := c.hub.hist
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]api.Event(nil), h.log[id]...), nil
}
