package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

func openTemp(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "f.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestTeamAndPackComeFromLabels(t *testing.T) {
	ctx := context.Background()
	rows := []struct {
		name         string
		labels       []string
		team, pack   string
		relabelTo    []string
		team2, pack2 string
	}{
		{"both", []string{"x", "team:alpha", "pack:go"}, "alpha", "go", nil, "", ""},
		{"none", []string{"x"}, "", "", nil, "", ""},
		{"first wins", []string{"team:a", "team:b"}, "a", "", nil, "", ""},
		{"relabel replaces", []string{"team:a", "pack:go"}, "a", "go", []string{"team:b"}, "b", ""},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			s := openTemp(t)
			tk := api.Ticket{ID: "1", Repo: "o/r", Workflow: "build", Labels: r.labels, CreatedAt: time.Unix(1, 0)}
			if err := s.PutTicket(ctx, tk); err != nil {
				t.Fatal(err)
			}
			got, err := s.ReportRows(ctx)
			if err != nil || len(got) != 1 {
				t.Fatalf("%v %v", got, err)
			}
			if got[0].Team != r.team || got[0].Pack != r.pack || got[0].Workflow != "build" {
				t.Fatalf("row %+v", got[0])
			}
			if r.relabelTo != nil {
				tk.Labels = r.relabelTo
				if err := s.PutTicket(ctx, tk); err != nil {
					t.Fatal(err)
				}
				got, _ = s.ReportRows(ctx)
				if got[0].Team != r.team2 || got[0].Pack != r.pack2 {
					t.Fatalf("after relabel %+v", got[0])
				}
			}
		})
	}
}

func TestReportRowsJoinThreadAndSpend(t *testing.T) {
	ctx := context.Background()
	s := openTemp(t)
	if err := s.PutTicket(ctx, api.Ticket{ID: "1", Repo: "o/r", CreatedAt: time.Unix(1, 0)}); err != nil {
		t.Fatal(err)
	}
	if err := s.PutTicket(ctx, api.Ticket{ID: "2", Repo: "o/r", CreatedAt: time.Unix(1, 0)}); err != nil {
		t.Fatal(err)
	}
	// Attempts are written out of order on purpose; rows come back by attempt.
	for _, a := range []int{2, 1} {
		o := api.Observation{Ticket: "1", Attempt: a, Branch: "b", Usage: api.Usage{InputTokens: int64(a * 10), OutputTokens: 1, CostUSD: float64(a)}}
		if err := s.Apply(ctx, o); err != nil {
			t.Fatal(err)
		}
	}
	th := Thread{FirstDispatch: time.Unix(100, 0), MergedAt: time.Unix(500, 0), ChatopsCommands: 2, ManualPushes: 3}
	if err := s.RecordThread(ctx, "1", th); err != nil {
		t.Fatal(err)
	}
	got, err := s.ReportRows(ctx)
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
	one, two := got[0], got[1]
	if one.ID != "1" || !one.FirstDispatch.Equal(th.FirstDispatch) || !one.MergedAt.Equal(th.MergedAt) || one.ChatopsCommands != 2 || one.ManualPushes != 3 {
		t.Fatalf("ticket 1 %+v", one)
	}
	if len(one.Attempts) != 2 || one.Attempts[0].N != 1 || one.Attempts[1].Usage.InputTokens != 20 || one.Attempts[1].Usage.CostUSD != 2 {
		t.Fatalf("attempts %+v", one.Attempts)
	}
	// A ticket with no thread data has zero times and counts, not an error.
	if two.ID != "2" || !two.MergedAt.IsZero() || !two.FirstDispatch.IsZero() || two.ChatopsCommands != 0 || len(two.Attempts) != 0 {
		t.Fatalf("ticket 2 %+v", two)
	}
}

// threadTracker is the porttest tracker that also reports each ticket's thread.
type threadTracker struct {
	*porttest.Tracker
	threads map[api.TicketID]Thread
}

func (t threadTracker) Thread(_ context.Context, id api.TicketID) (Thread, error) {
	return t.threads[id], nil
}

func TestReportTablesSurviveRebuildFromTracker(t *testing.T) {
	ctx := context.Background()
	ts, obs := fixtures()
	ts[0].Labels = []string{"x", "team:alpha", "pack:go"}
	ts[1].Labels = []string{"team:beta"}
	threads := map[api.TicketID]Thread{
		"1": {FirstDispatch: time.Unix(1000, 0), MergedAt: time.Unix(5000, 0), ChatopsCommands: 1, ManualPushes: 2},
		"2": {FirstDispatch: time.Unix(2000, 0)}, // dispatched, never merged
	}
	world := func() (threadTracker, *porttest.Observer) {
		tr := porttest.NewTracker(ts...)
		tr.Phases["1"], tr.Phases["2"] = api.PhaseRunning, api.PhaseRunning
		o := porttest.NewObserver()
		for _, x := range obs {
			o.Set(x)
		}
		return threadTracker{tr, threads}, o
	}

	live := openTemp(t)
	for _, tk := range ts {
		if err := live.PutTicket(ctx, tk); err != nil {
			t.Fatal(err)
		}
	}
	for _, o := range obs {
		if err := live.Apply(ctx, o); err != nil {
			t.Fatal(err)
		}
	}
	for id, th := range threads {
		if err := live.RecordThread(ctx, id, th); err != nil {
			t.Fatal(err)
		}
	}
	before, _ := live.Dump(ctx)

	fresh := openTemp(t)
	tr, o := world()
	if err := fresh.Rebuild(ctx, tr, o); err != nil {
		t.Fatal(err)
	}
	after, _ := fresh.Dump(ctx)
	if len(before) != len(after) {
		t.Fatalf("rows %d, want %d\n%v\n%v", len(after), len(before), after, before)
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("row %d differs:\n live    %s\n rebuilt %s", i, before[i], after[i])
		}
	}
	var seen int
	for _, l := range after {
		if strings.HasPrefix(l, "ticket_times:") || strings.HasPrefix(l, "ticket_meta:") || strings.HasPrefix(l, "ticket_touches:") {
			seen++
		}
	}
	if seen != 3+2+2 { // meta for 3 tickets, times and touches for 2
		t.Fatalf("report rows in dump = %d\n%v", seen, after)
	}
}
