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

// Symphony §14: restart reads every claimed and unfinished ticket.
func TestTrackerActiveFollowsPhase(t *testing.T) {
	tr := NewTracker(api.Ticket{ID: "1"}, api.Ticket{ID: "2"})
	ctx := context.Background()
	ids := func() []api.TicketID {
		got, err := tr.Active(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var out []api.TicketID
		for _, x := range got {
			out = append(out, x.ID)
		}
		return out
	}
	if got := ids(); len(got) != 0 {
		t.Fatalf("active before any claim = %v", got)
	}
	for _, c := range []struct {
		phase api.Phase
		want  int
	}{
		{api.PhaseClaimed, 1}, {api.PhaseRunning, 1}, {api.PhaseStalled, 1}, {api.PhaseRetryQueue, 1}, {api.PhaseQueued, 1},
		{api.PhaseReady, 0}, {api.PhaseDone, 0}, {api.PhaseMerged, 0}, {api.PhaseNeedsHuman, 0}, {api.PhaseCanceled, 0},
	} {
		_ = tr.SetPhase(ctx, "1", c.phase)
		if got := ids(); len(got) != c.want {
			t.Errorf("phase %s: active = %v, want %d", c.phase, got, c.want)
		}
	}
}

func TestObserverLatestReturnsHighestAttempt(t *testing.T) {
	o := NewObserver()
	ctx := context.Background()
	o.Set(api.Observation{Ticket: "7", Attempt: 1})
	o.Set(api.Observation{Ticket: "7", Attempt: 2})
	o.Set(api.Observation{Ticket: "7", Attempt: 1})
	got, err := o.Latest(ctx, "7")
	if err != nil || got.Attempt != 2 {
		t.Fatalf("Latest = %+v, %v; want attempt 2", got, err)
	}
	empty, err := o.Latest(ctx, "8")
	if err != nil || empty.Ticket != "8" || empty.Attempt != 0 {
		t.Fatalf("Latest of unknown = %+v, %v", empty, err)
	}
}

func TestControlSatisfiesBothAndControlOnlyHidesHistory(t *testing.T) {
	c := NewControl(api.Board{})
	var ctl api.Control = c
	if _, ok := ctl.(api.Historian); !ok {
		t.Fatal("Control is not a Historian")
	}
	if _, ok := c.ControlOnly().(api.Historian); ok {
		t.Fatal("ControlOnly still exposes History")
	}
	ctx, cancel := context.WithCancel(context.Background())
	ch, _ := c.Events(ctx)
	c.Seed("1", api.Event{Kind: "old"})
	c.Push(api.Event{Kind: "live"})
	if e := <-ch; e.Kind != "live" {
		t.Fatalf("got %q", e.Kind)
	}
	h, _ := c.History(ctx, "1")
	if len(h) != 1 || h[0].Kind != "old" {
		t.Fatalf("history %v", h)
	}
	cancel()
	for range ch {
	}
	if c.Subscribers() != 0 {
		t.Fatal("subscriber not removed")
	}
}
