package meter

import (
	"context"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

// Thread is api.Thread: the tracker comment the ledger reads and rewrites.
type Thread = api.Thread

// Ledger keeps a holder's per-attempt token totals in the ticket's spend comment.
type Ledger struct {
	Thread Thread
	Holder string
}

// Add records the absolute total attempt reported. A total no larger than the row already there
// writes nothing, so replaying an event, or a restarted meter handing the whole total over again,
// never counts twice. delta.CostUSD joins the holder's cost only when the row's tokens grew.
func (l Ledger) Add(ctx context.Context, id api.TicketID, attempt int, total, delta api.Usage) error {
	body, err := l.Thread.SpendComment(ctx, id)
	if err != nil {
		return err
	}
	spends, err := DecodeSpend(body)
	if err != nil {
		return err
	}
	at := -1
	for i, s := range spends {
		if s.Holder == l.Holder && s.Day == "" {
			at = i
		}
	}
	if at < 0 {
		spends = append(spends, Spend{Holder: l.Holder})
		at = len(spends) - 1
	}
	s := &spends[at]
	row := -1
	for i, a := range s.Attempts {
		if a.N == attempt {
			row = i
		}
	}
	if row < 0 {
		s.Attempts = append(s.Attempts, AttemptTokens{N: attempt})
		row = len(s.Attempts) - 1
	}
	a := &s.Attempts[row]
	next := AttemptTokens{N: attempt, Input: max(a.Input, total.InputTokens), Output: max(a.Output, total.OutputTokens),
		CacheRead: max(a.CacheRead, total.CacheReadTokens), CacheWrite: max(a.CacheWrite, total.CacheWriteTokens)}
	if next == *a {
		return nil
	}
	if next != *a {
		s.CostUSD += max(delta.CostUSD, 0)
	}
	*a = next
	s.Runs = len(s.Attempts)
	parts := make([]string, len(spends))
	for i, sp := range spends {
		parts[i] = EncodeSpend(sp)
	}
	return l.Thread.PutSpendComment(ctx, id, strings.Join(parts, "\n"))
}

// TicketSpend returns every spend marker on the ticket's spend comment.
func (l Ledger) TicketSpend(ctx context.Context, id api.TicketID) ([]Spend, error) {
	body, err := l.Thread.SpendComment(ctx, id)
	if err != nil {
		return nil, err
	}
	return DecodeSpend(body)
}
