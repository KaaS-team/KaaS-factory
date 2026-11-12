// Package report builds the unit-economics report: is the factory paying for itself.
package report

import (
	"context"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Window is the half-open span [Since, Until) a report covers.
type Window struct {
	Since time.Time
	Until time.Time
}

// Attempt is one session attempt on a ticket and what it spent (Symphony §13.5 absolute totals).
type Attempt struct {
	N     int       `json:"n"`
	Usage api.Usage `json:"usage"`
}

// TicketRecord is everything the report needs to know about one ticket. The Source fills it from
// the store (sessions, spend) and the tracker thread (merge time, chatops, pushes).
type TicketRecord struct {
	ID              api.TicketID
	Team            string
	Workflow        string
	Pack            string
	Attempts        []Attempt
	FirstDispatch   time.Time // zero if never dispatched
	MergedAt        time.Time // zero if the PR never merged
	ChatopsCommands int       // `/factory` commands from humans on the ticket
	ManualPushes    int       // pushes by a human to the ticket branch
}

// Source is the narrow read the report needs over the store and the ledger.
type Source interface {
	// Tickets returns every ticket with spend or a merge in the window.
	Tickets(ctx context.Context, w Window) ([]TicketRecord, error)
}
