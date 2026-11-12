package store

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

func bptr(b bool) *bool { return &b }

func fixtures() ([]api.Ticket, []api.Observation) {
	ts := []api.Ticket{
		{ID: "1", Repo: "o/r", Title: "one", Body: "b1", Labels: []string{"x"}, Files: []string{"a.go"}, Priority: 0, CreatedAt: time.Unix(100, 0).UTC()},
		{ID: "2", Repo: "o/r", Title: "two", BlockedBy: []api.TicketID{"1"}, Priority: 2, CreatedAt: time.Unix(200, 0).UTC()},
		{ID: "3", Repo: "o/r", Title: "three", CreatedAt: time.Unix(300, 0).UTC()},
	}
	obs := []api.Observation{
		{Ticket: "1", Attempt: 1, Branch: "factory/1-a1", LastPush: time.Unix(1000, 0).UTC(), HasReport: true, PR: 5, ChecksGreen: bptr(true), DiffFiles: []string{"a.go"}},
		{Ticket: "2", Attempt: 1, Branch: "factory/2-a1", LastPush: time.Unix(2000, 0).UTC(), Usage: api.Usage{InputTokens: 5, OutputTokens: 6, WallTime: time.Second}},
	}
	return ts, obs
}

// fakes build the tracker and observer that hold the world.
func fakes() (*porttest.Tracker, *porttest.Observer) {
	ts, obs := fixtures()
	tr := porttest.NewTracker(ts...)
	// 1 and 2 have work branches, so the tracker holds them as claimed work; 3 is still ready.
	tr.Phases["1"], tr.Phases["2"] = api.PhaseRunning, api.PhaseRunning
	o := porttest.NewObserver()
	for _, x := range obs {
		o.Set(x)
	}
	return tr, o
}

func TestRebuildMatchesLive(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	path := filepath.Join(dir, "factory.db")

	// Live store: written the way the reconcile loop writes it.
	live, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	ts, obs := fixtures()
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
	before, err := live.Dump(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) == 0 {
		t.Fatal("empty dump")
	}
	if err := live.Close(); err != nil {
		t.Fatal(err)
	}

	// Delete the database and rebuild from the fakes.
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(path + suffix)
	}
	fresh, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = fresh.Close() }()
	tr, o := fakes()
	if err := fresh.Rebuild(ctx, tr, o); err != nil {
		t.Fatal(err)
	}
	after, err := fresh.Dump(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != len(before) {
		t.Fatalf("rows %d, want %d\n%v\n%v", len(after), len(before), after, before)
	}
	for i := range before {
		if before[i] != after[i] {
			t.Fatalf("row %d differs:\n live    %s\n rebuilt %s", i, before[i], after[i])
		}
	}
}

func TestRebuildIsRepeatable(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "f.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	tr, o := fakes()
	if err := s.Rebuild(ctx, tr, o); err != nil {
		t.Fatal(err)
	}
	a, _ := s.Dump(ctx)
	if err := s.Rebuild(ctx, tr, o); err != nil {
		t.Fatal(err)
	}
	b, _ := s.Dump(ctx)
	if len(a) != len(b) {
		t.Fatalf("second rebuild changed row count: %d vs %d", len(a), len(b))
	}
}

func TestPhasesStored(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "f.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	tr, o := fakes()
	if err := s.Rebuild(ctx, tr, o); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[api.TicketID]api.Phase{"1": api.PhaseDone, "2": api.PhaseRunning, "3": api.PhaseReady} {
		got, err := s.Phase(ctx, id)
		if err != nil || got != want {
			t.Fatalf("phase of %s = %q (%v), want %q", id, got, err, want)
		}
	}
}

// RebuildIfEmpty rebuilds an empty store once and leaves a filled one alone (Symphony 14).
func TestRebuildIfEmpty(t *testing.T) {
	ctx := context.Background()
	s, err := Open(filepath.Join(t.TempDir(), "f.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	tr, o := fakes()
	for i, want := range []bool{true, false} {
		got, err := s.RebuildIfEmpty(ctx, tr, o)
		if err != nil || got != want {
			t.Fatalf("call %d: rebuilt = %v, err = %v, want %v", i, got, err, want)
		}
	}
	if p, err := s.Phase(ctx, "1"); err != nil || p != api.PhaseDone {
		t.Fatalf("phase of 1 = %q, %v", p, err)
	}
}
