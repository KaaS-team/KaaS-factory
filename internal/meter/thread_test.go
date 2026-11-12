package meter

import (
	"context"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

type memThread struct {
	body   string
	writes int
}

func (m *memThread) SpendComment(context.Context, api.TicketID) (string, error) { return m.body, nil }
func (m *memThread) PutSpendComment(_ context.Context, _ api.TicketID, b string) error {
	m.body = b
	m.writes++
	return nil
}

// Symphony 13.5: absolute totals in, never double counted. Two attempts leave one comment whose
// totals are the sum; replaying a total writes nothing, also after a restart (a fresh Ledger).
func TestLedgerAddTwoAttemptsNoDoubleCount(t *testing.T) {
	ctx := context.Background()
	th := &memThread{}
	l := Ledger{Thread: th, Holder: "alpha"}
	a1 := api.Usage{InputTokens: 100, OutputTokens: 40, CostUSD: 1}
	a2 := api.Usage{InputTokens: 30, OutputTokens: 10, CacheReadTokens: 5, CostUSD: 0.5}
	steps := []struct {
		attempt int
		total   api.Usage
		delta   api.Usage
		writes  int
	}{
		{1, api.Usage{InputTokens: 60, OutputTokens: 20, CostUSD: 0.5}, api.Usage{InputTokens: 60, OutputTokens: 20, CostUSD: 0.5}, 1},
		{1, a1, api.Usage{InputTokens: 40, OutputTokens: 20, CostUSD: 0.5}, 2},
		{1, a1, api.Usage{}, 2}, // same event again
		{2, a2, a2, 3},
		{2, a2, a2, 3}, // restart: a new meter hands over the whole total as a delta
	}
	for i, s := range steps {
		if i == 4 {
			l = Ledger{Thread: th, Holder: "alpha"}
		}
		if err := l.Add(ctx, "7", s.attempt, s.total, s.delta); err != nil {
			t.Fatal(err)
		}
		if th.writes != s.writes {
			t.Fatalf("step %d: writes = %d, want %d", i, th.writes, s.writes)
		}
	}
	got, err := DecodeSpend(th.body)
	if err != nil || len(got) != 1 {
		t.Fatalf("markers = %v, err = %v", got, err)
	}
	sp := got[0]
	if sp.Holder != "alpha" || sp.Runs != 2 || sp.CostUSD != 1.5 || len(sp.Attempts) != 2 {
		t.Fatalf("spend = %+v", sp)
	}
	var in, out int64
	for _, a := range sp.Attempts {
		in += a.Input
		out += a.Output
	}
	if in != 130 || out != 50 || sp.Attempts[1].CacheRead != 5 {
		t.Fatalf("attempts = %+v", sp.Attempts)
	}
	back, err := l.TicketSpend(ctx, "7")
	if err != nil || len(back) != 1 || back[0].Runs != 2 {
		t.Fatalf("TicketSpend = %+v, %v", back, err)
	}
}

// A session that has reported nothing leaves no comment behind (shadow runs write nothing).
func TestLedgerAddZeroUsageWritesNothing(t *testing.T) {
	th := &memThread{}
	if err := (Ledger{Thread: th, Holder: "alpha"}).Add(context.Background(), "7", 1, api.Usage{}, api.Usage{}); err != nil {
		t.Fatal(err)
	}
	if th.writes != 0 {
		t.Fatalf("writes = %d", th.writes)
	}
}
