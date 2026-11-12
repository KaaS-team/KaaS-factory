// Package shadow is an api.Dispatcher wrapper that runs nothing and records
// what the wrapped dispatcher would have been asked to do, so a team can
// watch the factory on its repo before it touches anything.
package shadow

import (
	"context"
	"fmt"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
)

// Action names what a record stands for.
type Action string

// The recorded actions.
const (
	ActionDispatch Action = "dispatch"
	ActionSteer    Action = "steer"
	ActionCancel   Action = "cancel"
)

// Record is one would-be action. Dispatcher is the inner dispatcher that
// would have run it.
type Record struct {
	Time       time.Time    `json:"time"`
	Action     Action       `json:"action"`
	Ticket     api.TicketID `json:"ticket"`
	Attempt    int          `json:"attempt"`
	Dispatcher string       `json:"dispatcher"`
	Brief      *api.Brief   `json:"brief,omitempty"`
	Session    *api.Session `json:"session,omitempty"`
	Message    string       `json:"message,omitempty"`
}

// Writer receives every record.
type Writer interface {
	Write(Record) error
}

type dispatcher struct {
	inner api.Dispatcher
	w     Writer
	now   func() time.Time
}

// New wraps inner so that no call reaches it except Name and Caps.
func New(inner api.Dispatcher, w Writer) api.Dispatcher {
	return NewWithClock(inner, w, time.Now)
}

// NewWithClock is New with the clock that stamps records.
func NewWithClock(inner api.Dispatcher, w Writer, now func() time.Time) api.Dispatcher {
	return &dispatcher{inner: inner, w: w, now: now}
}

func (d *dispatcher) Name() string   { return "shadow:" + d.inner.Name() }
func (d *dispatcher) Caps() api.Caps { return d.inner.Caps() }

// sessionFor is a pure function of the brief's ticket and attempt (Symphony 7.4).
func (d *dispatcher) sessionFor(t api.TicketID, attempt int) api.Session {
	key := fmt.Sprintf("shadow-%s-a%d", t, attempt)
	return api.Session{Key: key, ID: "shadow_" + key, Ticket: t, Attempt: attempt, Dispatcher: d.Name()}
}

func (d *dispatcher) Dispatch(_ context.Context, b api.Brief) (api.Session, error) {
	s := d.sessionFor(b.Ticket, b.Attempt)
	err := d.w.Write(Record{Time: d.now(), Action: ActionDispatch, Ticket: b.Ticket, Attempt: b.Attempt,
		Dispatcher: d.inner.Name(), Brief: &b, Session: &s})
	if err != nil {
		return api.Session{}, fmt.Errorf("shadow: record dispatch: %w", err)
	}
	return s, nil
}

func (d *dispatcher) Steer(_ context.Context, s api.Session, message string) error {
	return d.record(ActionSteer, s, message)
}

func (d *dispatcher) Cancel(_ context.Context, s api.Session) error {
	return d.record(ActionCancel, s, "")
}

func (d *dispatcher) Usage(context.Context, api.Session) (api.Usage, error) {
	return api.Usage{}, nil
}

func (d *dispatcher) record(a Action, s api.Session, msg string) error {
	err := d.w.Write(Record{Time: d.now(), Action: a, Ticket: s.Ticket, Attempt: s.Attempt,
		Dispatcher: d.inner.Name(), Session: &s, Message: msg})
	if err != nil {
		return fmt.Errorf("shadow: record %s: %w", a, err)
	}
	return nil
}

// Wrap returns the shadow dispatcher over d, recording to w, when cfg.Shadow is on, and d itself otherwise.
func Wrap(d api.Dispatcher, cfg config.Config, w Writer) api.Dispatcher {
	if !cfg.Shadow {
		return d
	}
	return New(d, w)
}
