package reconcile

import (
	"reflect"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func cfg() Config {
	return Config{Tick: 30 * time.Second, StallAfter: 10 * time.Minute, MaxAttempts: 3, MaxConcurrent: 2}
}

func tkt(id string, files ...string) api.Ticket {
	return api.Ticket{ID: api.TicketID(id), Files: files, CreatedAt: t0.Add(-time.Hour)}
}

func running(id string, attempt int, started time.Time) Entry {
	return Entry{Ticket: tkt(id), Phase: api.PhaseRunning, Attempt: attempt, StartedAt: started}
}

func obsPush(id string, attempt int, push time.Time) api.Observation {
	return api.Observation{Ticket: api.TicketID(id), Attempt: attempt, Branch: "factory/" + id, LastPush: push}
}

func st(entries ...Entry) State {
	s := State{Entries: map[api.TicketID]Entry{}, FiresLeft: 100}
	for _, e := range entries {
		s.Entries[e.Ticket.ID] = e
	}
	return s
}

func TestBackoff(t *testing.T) { // Symphony 8.4
	want := []time.Duration{10 * time.Second, 20 * time.Second, 40 * time.Second, 80 * time.Second, 160 * time.Second, 5 * time.Minute, 5 * time.Minute}
	for i, w := range want {
		if got := Backoff(i + 1); got != w {
			t.Errorf("attempt %d: got %v want %v", i+1, got, w)
		}
	}
	if Backoff(0) != 10*time.Second || Backoff(1000) != 5*time.Minute {
		t.Error("Backoff must clamp attempt below 1 and above the cap")
	}
}

func TestDecide(t *testing.T) { // Symphony 8.1 tick order, 17.4
	done := api.Observation{Ticket: "a", Attempt: 1, Branch: "b", LastPush: t0, HasReport: true, PR: 7}
	cases := []struct {
		name  string
		state func() State
		obs   []api.Observation
		cfg   func(*Config)
		want  []Action
	}{
		{"claim ready ticket", func() State { s := st(); s.Ready = []api.Ticket{tkt("a")}; return s }, nil, nil,
			[]Action{{Kind: Dispatch, ID: "a", Ticket: tkt("a"), Attempt: 1}}},
		{"no free slot", func() State {
			s := st(running("x", 1, t0), running("y", 1, t0))
			s.Ready = []api.Ticket{tkt("a")}
			return s
		}, []api.Observation{obsPush("x", 1, t0), obsPush("y", 1, t0)}, nil, nil},
		{"no fires left", func() State { s := st(); s.Ready = []api.Ticket{tkt("a")}; s.FiresLeft = 0; return s }, nil, nil, nil},
		{"preflight skips dispatch", func() State { s := st(); s.Ready = []api.Ticket{tkt("a")}; return s }, nil,
			func(c *Config) { c.MaxConcurrent = 0 }, nil},
		{"running and fresh", func() State { return st(running("a", 1, t0.Add(-time.Hour))) },
			[]api.Observation{obsPush("a", 1, t0.Add(-time.Minute))}, nil, nil},
		{"stall steers once", func() State { return st(running("a", 1, t0.Add(-time.Hour))) },
			[]api.Observation{obsPush("a", 1, t0.Add(-11*time.Minute))}, nil,
			[]Action{{Kind: Steer, ID: "a", Attempt: 1, Message: SteerMessage}}},
		{"already steered stays quiet", func() State {
			e := running("a", 1, t0.Add(-time.Hour))
			e.SteeredAt = t0.Add(-time.Minute)
			return st(e)
		}, []api.Observation{obsPush("a", 1, t0.Add(-12*time.Minute))}, nil, nil},
		{"push after steer can steer again", func() State {
			e := running("a", 1, t0.Add(-time.Hour))
			e.SteeredAt = t0.Add(-30 * time.Minute)
			return st(e)
		}, []api.Observation{obsPush("a", 1, t0.Add(-11*time.Minute))}, nil,
			[]Action{{Kind: Steer, ID: "a", Attempt: 1, Message: SteerMessage}}},
		{"no push at twice stall retries", func() State {
			e := running("a", 1, t0.Add(-time.Hour))
			e.SteeredAt = t0.Add(-10 * time.Minute)
			return st(e)
		}, []api.Observation{obsPush("a", 1, t0.Add(-20*time.Minute))}, nil,
			[]Action{{Kind: Retry, ID: "a", Attempt: 1, At: t0.Add(10 * time.Second), Reason: "stalled"}}},
		{"retry backoff grows with attempt", func() State { return st(running("a", 2, t0.Add(-time.Hour))) }, nil, nil,
			[]Action{{Kind: Retry, ID: "a", Attempt: 2, At: t0.Add(20 * time.Second), Reason: "stalled"}}},
		{"max attempts needs human", func() State { return st(running("a", 3, t0.Add(-time.Hour))) }, nil, nil,
			[]Action{{Kind: NeedsHuman, ID: "a", Attempt: 3, Reason: "stalled after 3 attempts"}}},
		{"stall uses start when never pushed", func() State { return st(running("a", 1, t0.Add(-11*time.Minute))) }, nil, nil,
			[]Action{{Kind: Steer, ID: "a", Attempt: 1, Message: SteerMessage}}},
		{"stall disabled", func() State { return st(running("a", 1, t0.Add(-9*time.Hour))) }, nil,
			func(c *Config) { c.StallAfter = 0 }, nil},
		{"pushed branch without report is running", func() State { return st(running("a", 1, t0.Add(-time.Minute))) },
			[]api.Observation{{Ticket: "a", Attempt: 1, Branch: "b", LastPush: t0, PR: 7}}, nil, nil},
		{"report without PR is running", func() State { return st(running("a", 1, t0.Add(-time.Minute))) },
			[]api.Observation{{Ticket: "a", Attempt: 1, Branch: "b", LastPush: t0, HasReport: true}}, nil, nil},
		{"branch report and PR is done", func() State { return st(running("a", 1, t0.Add(-time.Minute))) },
			[]api.Observation{done}, nil, []Action{{Kind: MarkDone, ID: "a", Attempt: 1}}},
		{"done wins over stall", func() State { return st(running("a", 1, t0.Add(-9*time.Hour))) },
			[]api.Observation{done}, nil, []Action{{Kind: MarkDone, ID: "a", Attempt: 1}}},
		{"stale observation ignored", func() State { return st(running("a", 2, t0.Add(-time.Minute))) },
			[]api.Observation{done}, nil, nil},
		{"terminal cancels", func() State {
			s := st(running("a", 1, t0))
			s.Terminal = map[api.TicketID]bool{"a": true}
			return s
		}, nil, nil, []Action{{Kind: Cancel, ID: "a", Attempt: 1, Reason: "terminal"}}},
		{"operator cancel", func() State {
			s := st(running("a", 1, t0))
			s.CancelRequested = map[api.TicketID]bool{"a": true}
			return s
		}, nil, nil, []Action{{Kind: Cancel, ID: "a", Attempt: 1, Reason: "canceled"}}},
		{"retry not due waits", func() State {
			return st(Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0.Add(time.Second)})
		}, nil, nil, nil},
		{"retry due redispatches next attempt", func() State {
			return st(Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0})
		}, nil, nil, []Action{{Kind: Dispatch, ID: "a", Ticket: tkt("a"), Attempt: 2}}},
		{"retry due but no slot", func() State {
			return st(running("x", 1, t0), running("y", 1, t0),
				Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0})
		}, []api.Observation{obsPush("x", 1, t0), obsPush("y", 1, t0)}, nil,
			[]Action{{Kind: Requeue, ID: "a", Attempt: 1, Reason: SlotsExhausted}}},
		{"retry no slot, reason already recorded", func() State {
			return st(running("x", 1, t0), running("y", 1, t0),
				Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0, Error: SlotsExhausted})
		}, []api.Observation{obsPush("x", 1, t0), obsPush("y", 1, t0)}, nil, nil},
		{"ready failed: due retry not dispatched", func() State {
			s := st(Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0})
			s.noDispatch = true
			return s
		}, nil, nil, nil},
		{"observation failed: no stall decision", func() State {
			s := st(running("a", 1, t0.Add(-time.Hour)))
			s.Unobserved = map[api.TicketID]bool{"a": true}
			return s
		}, nil, nil, nil},
		{"retry takes the slot before new work", func() State {
			s := st(running("x", 1, t0), Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0})
			s.Ready = []api.Ticket{tkt("b")}
			return s
		}, []api.Observation{obsPush("x", 1, t0)}, nil, []Action{{Kind: Dispatch, ID: "a", Ticket: tkt("a"), Attempt: 2}}},
		{"retry terminal cancels", func() State {
			s := st(Entry{Ticket: tkt("a"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0})
			s.Terminal = map[api.TicketID]bool{"a": true}
			return s
		}, nil, nil, []Action{{Kind: Cancel, ID: "a", Attempt: 1, Reason: "terminal"}}},
		{"retry holds its files", func() State {
			s := st(Entry{Ticket: tkt("a", "src/"), Phase: api.PhaseRetryQueue, Attempt: 1, RetryAt: t0.Add(time.Hour)})
			s.Ready = []api.Ticket{tkt("b", "src/x.go"), tkt("c", "docs")}
			return s
		}, nil, nil, []Action{{Kind: Dispatch, ID: "c", Ticket: tkt("c", "docs"), Attempt: 1}}},
		{"reconcile comes before dispatch", func() State {
			s := st(running("a", 1, t0))
			s.Terminal = map[api.TicketID]bool{"a": true}
			s.Ready = []api.Ticket{tkt("b")}
			return s
		}, nil, nil, []Action{
			{Kind: Cancel, ID: "a", Attempt: 1, Reason: "terminal"},
			{Kind: Dispatch, ID: "b", Ticket: tkt("b"), Attempt: 1},
		}},
		{"entry already tracked is not claimed twice", func() State {
			s := st(running("a", 1, t0))
			s.Ready = []api.Ticket{tkt("a")}
			return s
		}, []api.Observation{obsPush("a", 1, t0)}, nil, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			cf := cfg()
			if c.cfg != nil {
				c.cfg(&cf)
			}
			got := Decide(c.state(), c.obs, t0, cf)
			if len(got) == 0 && len(c.want) == 0 {
				return
			}
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got  %+v\nwant %+v", got, c.want)
			}
		})
	}
}

func TestDecideDeterministic(t *testing.T) {
	s := st()
	s.Ready = []api.Ticket{tkt("c"), tkt("a"), tkt("b")}
	cf := cfg()
	cf.MaxConcurrent = 5
	first := Decide(s, nil, t0, cf)
	for range 20 {
		if got := Decide(s, nil, t0, cf); !reflect.DeepEqual(got, first) {
			t.Fatal("Decide is not deterministic")
		}
	}
}
