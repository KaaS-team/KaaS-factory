package reconcile

import (
	"context"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/reconcile/eventlog"
)

// Publisher is the optional port for the two side effects that publish a finished run. Each is a
// durable step: its result is written to the event log before the next step runs.
type Publisher interface {
	// Push publishes the branch. It must be safe to skip once it has returned nil.
	Push(ctx context.Context, id api.TicketID, attempt int, branch string) error
	// OpenPR opens the draft pull request and returns its number.
	OpenPR(ctx context.Context, id api.TicketID, attempt int, branch string) (int, error)
}

// Names of the durable publish steps.
const (
	StepPush   = "push"
	StepOpenPR = "open-pr"
)

// durable runs fn once per (ticket, attempt, name). A step already in the log is skipped and
// reports false. A step that fails is not recorded, so the next tick tries it again.
func (d Deps) durable(id api.TicketID, attempt int, name string, done map[string]bool, fn func() error) bool {
	key := eventlog.StepKey(attempt, name)
	if done[key] {
		return false
	}
	if err := fn(); err != nil {
		d.report(err)
		return false
	}
	done[key] = true
	d.logStep(id, eventlog.Event{Kind: eventlog.KindStep, Attempt: attempt, Reason: name})
	return true
}

// loggedSteps reads the ticket's done steps; a read error is reported and means none.
func (d Deps) loggedSteps(id api.TicketID) map[string]bool {
	if d.Log == nil {
		return map[string]bool{}
	}
	m, err := d.Log.Steps(id)
	d.report(err)
	if m == nil {
		m = map[string]bool{}
	}
	return m
}

// publish runs push then PR open for each observation that has a branch and a report but no pull
// request. It returns the observations with the new PR numbers, so Decide sees them.
func publish(ctx context.Context, d Deps, s *State, obs []api.Observation) []api.Observation {
	if d.Publisher == nil {
		return obs
	}
	for i, o := range obs {
		if ctx.Err() != nil {
			return obs
		}
		e, ok := s.Entries[o.Ticket]
		if !ok || o.Attempt != e.Attempt || o.Branch == "" || !o.HasReport || o.PR != 0 {
			continue
		}
		done := d.loggedSteps(o.Ticket)
		d.durable(o.Ticket, o.Attempt, StepPush, done, func() error {
			return d.Publisher.Push(ctx, o.Ticket, o.Attempt, o.Branch)
		})
		if !done[eventlog.StepKey(o.Attempt, StepPush)] || ctx.Err() != nil {
			continue
		}
		d.durable(o.Ticket, o.Attempt, StepOpenPR, done, func() error {
			n, err := d.Publisher.OpenPR(ctx, o.Ticket, o.Attempt, o.Branch)
			if n > 0 {
				obs[i].PR = n
			}
			return err
		})
	}
	return obs
}
