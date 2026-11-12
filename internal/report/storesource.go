package report

import (
	"context"
	"fmt"
	"sort"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/store"
)

// Store is the read the report needs of the store; *store.Store implements it.
type Store interface {
	ReportRows(ctx context.Context) ([]store.TicketRow, error)
}

// Ledger reads the usage records the meter wrote on a ticket's thread.
type Ledger interface {
	// TicketSpend returns every decoded `<!-- factory:spend -->` marker on the ticket.
	TicketSpend(ctx context.Context, id api.TicketID) ([]meter.Spend, error)
}

// StoreSource implements Source from the store, with the ledger filling attempts the store never saw.
// Ledger may be nil.
type StoreSource struct {
	Store  Store
	Ledger Ledger
}

// Tickets returns each ticket that has spend or merged inside w, ordered by id. Spend rows carry no
// time, so a ticket with spend is returned whatever the window; Build counts it as a merged PR only
// when it merged inside w.
func (s StoreSource) Tickets(ctx context.Context, w Window) ([]TicketRecord, error) {
	rows, err := s.Store.ReportRows(ctx)
	if err != nil {
		return nil, fmt.Errorf("read store: %w", err)
	}
	var out []TicketRecord
	for _, r := range rows {
		rec := TicketRecord{
			ID: r.ID, Team: r.Team, Workflow: r.Workflow, Pack: r.Pack,
			FirstDispatch: r.FirstDispatch, MergedAt: r.MergedAt,
			ChatopsCommands: r.ChatopsCommands, ManualPushes: r.ManualPushes,
		}
		for _, a := range r.Attempts {
			rec.Attempts = append(rec.Attempts, Attempt{N: a.N, Usage: a.Usage})
		}
		if s.Ledger != nil {
			spend, err := s.Ledger.TicketSpend(ctx, r.ID)
			if err != nil {
				return nil, fmt.Errorf("read ledger of %s: %w", r.ID, err)
			}
			rec.Attempts = fillFromLedger(rec.Attempts, spend)
		}
		if len(rec.Attempts) == 0 && !Merged(rec, w) {
			continue
		}
		out = append(out, rec)
	}
	return out, nil
}

// fillFromLedger adds an attempt for each number the ledger has and have lacks, tokens only (the
// ledger keeps one cost per holder, not per attempt). Where holders disagree on an attempt, the
// larger total of each field wins, since totals only grow.
func fillFromLedger(have []Attempt, spend []meter.Spend) []Attempt {
	known := map[int]bool{}
	for _, a := range have {
		known[a.N] = true
	}
	extra := map[int]api.Usage{}
	for _, sp := range spend {
		for _, a := range sp.Attempts {
			if known[a.N] {
				continue
			}
			u := extra[a.N]
			u.InputTokens = max(u.InputTokens, a.Input)
			u.OutputTokens = max(u.OutputTokens, a.Output)
			u.CacheReadTokens = max(u.CacheReadTokens, a.CacheRead)
			u.CacheWriteTokens = max(u.CacheWriteTokens, a.CacheWrite)
			extra[a.N] = u
		}
	}
	for n, u := range extra {
		have = append(have, Attempt{N: n, Usage: u})
	}
	sort.Slice(have, func(i, j int) bool { return have[i].N < have[j].N })
	return have
}
