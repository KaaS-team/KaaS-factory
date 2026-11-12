package porttest

import (
	"context"
	"sync"

	"github.com/KaaS-team/factory/internal/api"
)

// Control is a fake api.Control and api.Historian for client tests. It serves
// BoardVal, records every write as "verb id" (steer adds ": message"), hands
// pushed events to each live subscriber and serves seeded history.
type Control struct {
	mu        sync.Mutex
	BoardVal  api.Board
	OnWrite   func(call string) // called after a write is recorded; may be nil
	calls     []string
	history   map[api.TicketID][]api.Event
	subs      []chan api.Event
	histCalls []api.TicketID
	subbed    chan struct{}
	subOnce   sync.Once
}

var (
	_ api.Control   = (*Control)(nil)
	_ api.Historian = (*Control)(nil)
)

// NewControl returns a fake serving the given board.
func NewControl(b api.Board) *Control {
	return &Control{BoardVal: b, history: map[api.TicketID][]api.Event{}, subbed: make(chan struct{})}
}

func (c *Control) write(s string) error {
	c.mu.Lock()
	c.calls = append(c.calls, s)
	f := c.OnWrite
	c.mu.Unlock()
	if f != nil {
		f(s)
	}
	return nil
}

// Calls returns the recorded writes in order.
func (c *Control) Calls() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.calls...)
}

// HistoryCalls returns the ticket ids History was asked for, in order.
func (c *Control) HistoryCalls() []api.TicketID {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]api.TicketID(nil), c.histCalls...)
}

// Board returns BoardVal.
func (c *Control) Board(context.Context) (api.Board, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.BoardVal, nil
}

// Dispatch records "dispatch <id>".
func (c *Control) Dispatch(_ context.Context, id api.TicketID) error {
	return c.write("dispatch " + string(id))
}

// Steer records "steer <id>: <message>".
func (c *Control) Steer(_ context.Context, id api.TicketID, m string) error {
	return c.write("steer " + string(id) + ": " + m)
}

// Cancel records "cancel <id>".
func (c *Control) Cancel(_ context.Context, id api.TicketID) error {
	return c.write("cancel " + string(id))
}

// Retry records "retry <id>".
func (c *Control) Retry(_ context.Context, id api.TicketID) error {
	return c.write("retry " + string(id))
}

// Events opens a live stream that Push feeds; it closes when ctx ends.
func (c *Control) Events(ctx context.Context) (<-chan api.Event, error) {
	ch := make(chan api.Event, 64)
	c.mu.Lock()
	c.subs = append(c.subs, ch)
	c.mu.Unlock()
	c.subOnce.Do(func() { close(c.subbed) })
	go func() {
		<-ctx.Done()
		c.mu.Lock()
		defer c.mu.Unlock()
		for i, s := range c.subs {
			if s == ch {
				c.subs = append(c.subs[:i], c.subs[i+1:]...)
				close(ch)
				return
			}
		}
	}()
	return ch, nil
}

// Subscribed is closed once the first Events call has been made.
func (c *Control) Subscribed() <-chan struct{} { return c.subbed }

// Subscribers is the number of open event streams.
func (c *Control) Subscribers() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.subs)
}

// Push sends an event to every open stream. It does not touch history; use Seed for that.
// A stream whose buffer of 64 is full loses the event.
func (c *Control) Push(ev api.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, s := range c.subs {
		select {
		case s <- ev:
		default:
		}
	}
}

// Seed appends events to a ticket's history, as the core would have recorded them.
func (c *Control) Seed(id api.TicketID, evs ...api.Event) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.history[id] = append(c.history[id], evs...)
}

// History returns a copy of the seeded events for id, oldest first.
func (c *Control) History(_ context.Context, id api.TicketID) ([]api.Event, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.histCalls = append(c.histCalls, id)
	return append([]api.Event(nil), c.history[id]...), nil
}

// ControlOnly hides History, so a client sees a Control that is not an api.Historian.
func (c *Control) ControlOnly() api.Control { return controlOnly{c} }

type controlOnly struct{ api.Control }
