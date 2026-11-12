package porttest

import (
	"context"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

func TestDispatchIsIdempotentPerAttempt(t *testing.T) {
	d := NewDispatcher(6)
	ctx := context.Background()
	a, _ := d.Dispatch(ctx, api.Brief{Ticket: "7", Attempt: 1})
	b, _ := d.Dispatch(ctx, api.Brief{Ticket: "7", Attempt: 1})
	c, _ := d.Dispatch(ctx, api.Brief{Ticket: "7", Attempt: 2})
	if a.ID != b.ID {
		t.Fatalf("same attempt gave two sessions: %s %s", a.ID, b.ID)
	}
	if a.ID == c.ID {
		t.Fatalf("new attempt reused session %s", a.ID)
	}
}

func TestTrackerReadyDropsClaimed(t *testing.T) {
	tr := NewTracker(api.Ticket{ID: "1"}, api.Ticket{ID: "2"})
	ctx := context.Background()
	_ = tr.SetPhase(ctx, "1", api.PhaseRunning)
	got, _ := tr.Ready(ctx)
	if len(got) != 1 || got[0].ID != "2" {
		t.Fatalf("ready = %+v, want only 2", got)
	}
}
