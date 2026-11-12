package report

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/store"
)

type fakeLedger struct {
	by  map[api.TicketID][]meter.Spend
	err error
}

func (f fakeLedger) TicketSpend(_ context.Context, id api.TicketID) ([]meter.Spend, error) {
	return f.by[id], f.err
}

// seed fills a store with four tickets:
//
//	M  alpha build go   merged, one attempt (1000+500, $2), 1 chatops, dispatched h1, merged h5
//	F  alpha build go   failed once (400+100, $1) then merged (600+300, $1.5), 2 manual pushes, h2 to h12
//	N  beta  fix   web  never merged, store has attempt 1 (200+50, $0.5); the ledger adds attempt 2 (100 in)
//	P  beta  fix   web  no spend and no merge: not in the report
func seed(t *testing.T) *store.Store {
	t.Helper()
	ctx := context.Background()
	s, err := store.Open(filepath.Join(t.TempDir(), "f.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	for _, tk := range []api.Ticket{
		{ID: "M", Repo: "o/r", Workflow: "build", Labels: []string{"team:alpha", "pack:go"}},
		{ID: "F", Repo: "o/r", Workflow: "build", Labels: []string{"team:alpha", "pack:go"}},
		{ID: "N", Repo: "o/r", Workflow: "fix", Labels: []string{"team:beta", "pack:web"}},
		{ID: "P", Repo: "o/r", Workflow: "fix", Labels: []string{"team:beta", "pack:web"}},
	} {
		if err := s.PutTicket(ctx, tk); err != nil {
			t.Fatal(err)
		}
	}
	for _, o := range []api.Observation{
		{Ticket: "M", Attempt: 1, Branch: "b", Usage: use(1000, 500, 2)},
		{Ticket: "F", Attempt: 1, Branch: "b", Usage: use(400, 100, 1)},
		{Ticket: "F", Attempt: 2, Branch: "b", Usage: use(600, 300, 1.5)},
		{Ticket: "N", Attempt: 1, Branch: "b", Usage: use(200, 50, 0.5)},
	} {
		if err := s.Apply(ctx, o); err != nil {
			t.Fatal(err)
		}
	}
	for id, th := range map[api.TicketID]store.Thread{
		"M": {FirstDispatch: at(1), MergedAt: at(5), ChatopsCommands: 1},
		"F": {FirstDispatch: at(2), MergedAt: at(12), ManualPushes: 2},
		"N": {FirstDispatch: at(3)},
	} {
		if err := s.RecordThread(ctx, id, th); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

// Checked by hand. Merged tokens: M 1500 + F (500+900) 1400 = 2900. Unmerged: N 250 + 100 from the
// ledger = 350. Rework: F has two attempts = 1. Touches: M 1 + F 2 = 3. Cost: 2 + 2.5 + 0.5 = 5.
// Cycle: M 4h, F 10h = 14h over 2 samples.
func TestStoreSourceMatchesHandComputedReport(t *testing.T) {
	src := StoreSource{Store: seed(t), Ledger: fakeLedger{by: map[api.TicketID][]meter.Spend{
		"N": {{Holder: "w", Attempts: []meter.AttemptTokens{{N: 1, Input: 200, Output: 50}, {N: 2, Input: 100}}}},
	}}}
	r, err := Build(context.Background(), src, win)
	if err != nil {
		t.Fatal(err)
	}
	wantTotal := Row{Key: "all", MergedPRs: 2, MergedTokens: 2900, UnmergedTokens: 350, ReworkAttempts: 1,
		HumanTouches: 3, CostUSD: 5, CycleSamples: 2, CycleSeconds: 14 * 3600}
	if r.Total != wantTotal {
		t.Fatalf("total\n got %+v\nwant %+v", r.Total, wantTotal)
	}
	wantTeams := []Row{
		{Key: "alpha", MergedPRs: 2, MergedTokens: 2900, ReworkAttempts: 1, HumanTouches: 3, CostUSD: 4.5, CycleSamples: 2, CycleSeconds: 14 * 3600},
		{Key: "beta", UnmergedTokens: 350, CostUSD: 0.5},
	}
	if len(r.Teams) != 2 || r.Teams[0] != wantTeams[0] || r.Teams[1] != wantTeams[1] {
		t.Fatalf("teams\n got %+v\nwant %+v", r.Teams, wantTeams)
	}
	if p := r.Rows(ByPack); len(p) != 2 || p[0].Key != "go" || p[1].Key != "web" {
		t.Fatalf("packs %+v", p)
	}
	if w := r.Rows(ByWorkflow); len(w) != 2 || w[0].Key != "build" || w[0].MergedPRs != 2 {
		t.Fatalf("workflows %+v", w)
	}
}

func TestStoreSourceWindow(t *testing.T) {
	rows := []struct {
		name       string
		w          Window
		ids        []api.TicketID
		mergedOnly bool
	}{
		{"all", win, []api.TicketID{"F", "M", "N"}, false},
		// M merged at h5, F at h12: a window ending at h6 keeps M as merged and F as spend only.
		{"narrow", Window{Since: at(0), Until: at(6)}, []api.TicketID{"F", "M", "N"}, false},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			recs, err := StoreSource{Store: seed(t)}.Tickets(context.Background(), r.w)
			if err != nil {
				t.Fatal(err)
			}
			if len(recs) != len(r.ids) {
				t.Fatalf("got %d tickets %+v", len(recs), recs)
			}
			for i, id := range r.ids {
				if recs[i].ID != id {
					t.Fatalf("ticket %d = %s, want %s", i, recs[i].ID, id)
				}
			}
		})
	}
	recs, _ := StoreSource{Store: seed(t)}.Tickets(context.Background(), Window{Since: at(0), Until: at(6)})
	var merged []api.TicketID
	for _, rec := range recs {
		if Merged(rec, Window{Since: at(0), Until: at(6)}) {
			merged = append(merged, rec.ID)
		}
	}
	if len(merged) != 1 || merged[0] != "M" {
		t.Fatalf("merged in narrow window = %v", merged)
	}
}

func TestStoreSourceLedgerFillsOnlyMissingAttempts(t *testing.T) {
	rows := []struct {
		name  string
		spend []meter.Spend
		want  []Attempt
	}{
		{"no ledger rows", nil, []Attempt{{N: 1, Usage: use(200, 50, 0.5)}}},
		{"store wins for attempt 1", []meter.Spend{{Attempts: []meter.AttemptTokens{{N: 1, Input: 9999}}}},
			[]Attempt{{N: 1, Usage: use(200, 50, 0.5)}}},
		{"attempt 3 appended in order", []meter.Spend{{Attempts: []meter.AttemptTokens{{N: 3, Input: 7, CacheRead: 2, CacheWrite: 1}}}},
			[]Attempt{{N: 1, Usage: use(200, 50, 0.5)}, {N: 3, Usage: api.Usage{InputTokens: 7, CacheReadTokens: 2, CacheWriteTokens: 1}}}},
		{"two holders, larger total wins", []meter.Spend{
			{Attempts: []meter.AttemptTokens{{N: 2, Input: 5, Output: 1}}},
			{Attempts: []meter.AttemptTokens{{N: 2, Input: 8, Output: 0}}}},
			[]Attempt{{N: 1, Usage: use(200, 50, 0.5)}, {N: 2, Usage: use(8, 1, 0)}}},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			src := StoreSource{Store: seed(t), Ledger: fakeLedger{by: map[api.TicketID][]meter.Spend{"N": r.spend}}}
			recs, err := src.Tickets(context.Background(), win)
			if err != nil {
				t.Fatal(err)
			}
			var got []Attempt
			for _, rec := range recs {
				if rec.ID == "N" {
					got = rec.Attempts
				}
			}
			if len(got) != len(r.want) {
				t.Fatalf("attempts %+v, want %+v", got, r.want)
			}
			for i := range got {
				if got[i] != r.want[i] {
					t.Fatalf("attempt %d = %+v, want %+v", i, got[i], r.want[i])
				}
			}
		})
	}
}

func TestStoreSourceLedgerErrorFails(t *testing.T) {
	boom := errors.New("boom")
	_, err := StoreSource{Store: seed(t), Ledger: fakeLedger{err: boom}}.Tickets(context.Background(), win)
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v", err)
	}
}
