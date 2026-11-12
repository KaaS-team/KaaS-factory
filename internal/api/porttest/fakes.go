// Package porttest holds in-memory fakes of the api ports for unit tests.
package porttest

import (
	"context"
	"fmt"
	"sort"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/observe"
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
	Spend    map[api.TicketID]string           // the one spend comment per ticket, rewritten in place
	Position map[api.TicketID]observe.Position // the one workflow position per ticket, rewritten in place
}

// NewTracker returns a tracker holding the given ready tickets.
func NewTracker(ts ...api.Ticket) *Tracker {
	t := &Tracker{Tickets: map[api.TicketID]api.Ticket{}, Phases: map[api.TicketID]api.Phase{}, Comments: map[api.TicketID][]string{}, Spend: map[api.TicketID]string{}, Position: map[api.TicketID]observe.Position{}}
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

// Active lists tickets claimed and not finished: claimed, running, stalled, retry or merge-queue, by id.
func (t *Tracker) Active(context.Context) ([]api.Ticket, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var out []api.Ticket
	for id, x := range t.Tickets {
		switch t.Phases[id] {
		case api.PhaseClaimed, api.PhaseRunning, api.PhaseStalled, api.PhaseRetryQueue, api.PhaseQueued:
			out = append(out, x)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
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

// SpendComment returns the ticket's spend comment, or "" before the first write.
func (t *Tracker) SpendComment(_ context.Context, id api.TicketID) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.Spend[id], nil
}

// PutSpendComment replaces the ticket's spend comment.
func (t *Tracker) PutSpendComment(_ context.Context, id api.TicketID, body string) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Spend[id] = body
	return nil
}

// SavePosition replaces the ticket's workflow position.
func (t *Tracker) SavePosition(_ context.Context, id api.TicketID, p observe.Position) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Position[id] = p
	return nil
}

// LoadPosition returns the ticket's workflow position, false before the first save.
func (t *Tracker) LoadPosition(_ context.Context, id api.TicketID) (observe.Position, bool, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	p, ok := t.Position[id]
	return p, ok, nil
}

func (t *Tracker) SetPhase(_ context.Context, id api.TicketID, p api.Phase) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.Phases[id] = p
	return nil
}

// Observer returns canned observations.
type Observer struct {
	mu     sync.Mutex
	Obs    map[api.TicketID]api.Observation
	newest map[api.TicketID]api.Observation // highest attempt Set per ticket
}

// NewObserver returns an empty observer.
func NewObserver() *Observer {
	return &Observer{Obs: map[api.TicketID]api.Observation{}, newest: map[api.TicketID]api.Observation{}}
}

// Set stores the observation for its ticket.
func (o *Observer) Set(x api.Observation) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.Obs[x.Ticket] = x
	if cur, ok := o.newest[x.Ticket]; !ok || x.Attempt >= cur.Attempt {
		o.newest[x.Ticket] = x
	}
}

// Latest returns the observation with the highest attempt Set for id, or an empty one.
func (o *Observer) Latest(_ context.Context, id api.TicketID) (api.Observation, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if x, ok := o.newest[id]; ok {
		return x, nil
	}
	return api.Observation{Ticket: id}, nil
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
	_ api.Dispatcher     = (*Dispatcher)(nil)
	_ api.Tracker        = (*Tracker)(nil)
	_ api.Observer       = (*Observer)(nil)
	_ api.Lister         = (*Tracker)(nil)
	_ api.Thread         = (*Tracker)(nil)
	_ observe.Positioner = (*Tracker)(nil)
	_ api.LatestObserver = (*Observer)(nil)
)
