// Package porttest holds in-memory fakes of the api ports for unit tests.
package porttest

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Dispatcher records every call and returns deterministic sessions.
type Dispatcher struct {
	mu       sync.Mutex
	CapsVal  api.Caps
	Sessions map[string]api.Session
	Steers   []string
	Cancels  []string
	UsageBy  map[string]api.Usage
	Err      error
}

// NewDispatcher returns a fake with the given concurrency cap.
func NewDispatcher(maxConcurrent int) *Dispatcher {
	return &Dispatcher{
		CapsVal:  api.Caps{MaxConcurrent: maxConcurrent, Remote: true},
		Sessions: map[string]api.Session{},
		UsageBy:  map[string]api.Usage{},
	}
}

func (d *Dispatcher) Name() string   { return "fake" }
func (d *Dispatcher) Caps() api.Caps { return d.CapsVal }

// Dispatch is idempotent per (ticket, attempt), like the real adapters must be.
func (d *Dispatcher) Dispatch(_ context.Context, b api.Brief) (api.Session, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.Err != nil {
		return api.Session{}, d.Err
	}
	key := fmt.Sprintf("%s-a%d", b.Ticket, b.Attempt)
	if s, ok := d.Sessions[key]; ok {
		return s, nil
	}
	s := api.Session{Key: key, ID: "fake_" + key, Ticket: b.Ticket, Attempt: b.Attempt, Dispatcher: "fake", StartedAt: time.Unix(0, 0)}
	d.Sessions[key] = s
	return s, nil
}

func (d *Dispatcher) Steer(_ context.Context, s api.Session, msg string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.Steers = append(d.Steers, s.Key+": "+msg)
	return nil
}

func (d *Dispatcher) Cancel(_ context.Context, s api.Session) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.Cancels = append(d.Cancels, s.Key)
	return nil
}

func (d *Dispatcher) Usage(_ context.Context, s api.Session) (api.Usage, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return d.UsageBy[s.Key], nil
}

// Tracker is an in-memory tracker.
type Tracker struct {
	mu       sync.Mutex
	Tickets  map[api.TicketID]api.Ticket
	Phases   map[api.TicketID]api.Phase
	Comments map[api.TicketID][]string
}

// NewTracker returns a tracker holding the given ready tickets.
func NewTracker(ts ...api.Ticket) *Tracker {
	t := &Tracker{Tickets: map[api.TicketID]api.Ticket{}, Phases: map[api.TicketID]api.Phase{}, Comments: map[api.TicketID][]string{}}
	for _, x := range ts {
		t.Tickets[x.ID] = x
		t.Phases[x.ID] = api.PhaseReady
	}
	return t
}

func (t *Tracker) Name() string { return "fake" }

func (t *Tracker) Ready(context.Context) ([]api.Ticket, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []api.Ticket
	for id, x := range t.Tickets {
		if t.Phases[id] == api.PhaseReady {
			out = append(out, x)
		}
	}
	return out, nil
}

func (t *Tracker) Get(_ context.Context, id api.TicketID) (api.Ticket, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	x, ok := t.Tickets[id]
	if !ok {
		return api.Ticket{}, fmt.Errorf("ticket %s not found", id)
	}
	return x, nil
}

func (t *Tracker) Comment(_ context.Context, id api.TicketID, body string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Comments[id] = append(t.Comments[id], body)
	return nil
}

func (t *Tracker) SetPhase(_ context.Context, id api.TicketID, p api.Phase) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Phases[id] = p
	return nil
}

// Observer returns canned observations.
type Observer struct {
	mu  sync.Mutex
	Obs map[api.TicketID]api.Observation
}

// NewObserver returns an empty observer.
func NewObserver() *Observer { return &Observer{Obs: map[api.TicketID]api.Observation{}} }

// Set stores the observation for its ticket.
func (o *Observer) Set(x api.Observation) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.Obs[x.Ticket] = x
}

func (o *Observer) Observe(_ context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	x, ok := o.Obs[id]
	if !ok {
		return api.Observation{Ticket: id, Attempt: attempt}, nil
	}
	return x, nil
}

// Compile-time checks that the fakes satisfy the ports.
var (
	_ api.Dispatcher = (*Dispatcher)(nil)
	_ api.Tracker    = (*Tracker)(nil)
	_ api.Observer   = (*Observer)(nil)
)
