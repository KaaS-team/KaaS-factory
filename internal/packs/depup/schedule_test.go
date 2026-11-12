package depup

import (
	"context"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

func TestScheduleAllows(t *testing.T) {
	// US DST: 2026-03-08 02:00 local does not exist; 2026-11-01 01:30 local happens twice.
	tests := []struct {
		name string
		cron string
		tz   string
		at   time.Time
		want bool
	}{
		{"weekday nights match", "* 0-5 * * 1-5", "UTC", time.Date(2026, 11, 12, 3, 10, 0, 0, time.UTC), true},
		{"weekend does not", "* 0-5 * * 1-5", "UTC", time.Date(2026, 11, 14, 3, 10, 0, 0, time.UTC), false},
		{"timezone shifts hour", "0 9 * * *", "America/New_York", time.Date(2026, 11, 12, 14, 0, 0, 0, time.UTC), true},
		{"seconds are ignored", "0 9 * * *", "America/New_York", time.Date(2026, 11, 12, 14, 0, 59, 0, time.UTC), true},
		{"step and list", "*/15 8,20 * * *", "UTC", time.Date(2026, 11, 12, 20, 45, 0, 0, time.UTC), true},
		{"step miss", "*/15 8,20 * * *", "UTC", time.Date(2026, 11, 12, 20, 46, 0, 0, time.UTC), false},
		{"sunday as 7", "0 0 * * 7", "UTC", time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC), true},
		{"dom and month", "0 0 1 11 *", "UTC", time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), true},
		{"dst gap hour never matches", "30 2 * * *", "America/New_York", time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC), false},
		{"dst gap: 3:30 local is the next real minute", "30 3 * * *", "America/New_York", time.Date(2026, 3, 8, 7, 30, 0, 0, time.UTC), true},
		{"dst overlap first 1:30", "30 1 * * *", "America/New_York", time.Date(2026, 11, 1, 5, 30, 0, 0, time.UTC), true},
		{"dst overlap second 1:30", "30 1 * * *", "America/New_York", time.Date(2026, 11, 1, 6, 30, 0, 0, time.UTC), true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s, err := ParseSchedule(tc.cron, tc.tz)
			if err != nil {
				t.Fatal(err)
			}
			if got := s.Allows(tc.at); got != tc.want {
				t.Errorf("Allows(%v) = %v, want %v", tc.at, got, tc.want)
			}
		})
	}
}

func TestScheduleEmptyAlwaysAllows(t *testing.T) {
	s, err := ParseSchedule("", "")
	if err != nil || !s.Allows(time.Now()) {
		t.Fatalf("empty schedule must allow: %v", err)
	}
}

func TestParseScheduleErrors(t *testing.T) {
	for _, c := range []struct{ cron, tz string }{
		{"* * * *", "UTC"}, {"61 * * * *", "UTC"}, {"a * * * *", "UTC"}, {"*/0 * * * *", "UTC"},
		{"5-1 * * * *", "UTC"}, {"* * * * *", "Mars/Base"},
	} {
		if _, err := ParseSchedule(c.cron, c.tz); err == nil {
			t.Errorf("%q %q: want error", c.cron, c.tz)
		}
	}
}

func dep(id string, age time.Duration, now time.Time) api.Ticket {
	return api.Ticket{ID: api.TicketID(id), Labels: []string{Label}, CreatedAt: now.Add(-age)}
}

// Symphony 8.3 concurrency control and 14.3 restart: limits are read from the tracker, never held in memory.
func TestDecideOutcomes(t *testing.T) {
	now := time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC)
	night, _ := ParseSchedule("* 0-5 * * *", "UTC")
	day, _ := ParseSchedule("* 9-17 * * *", "UTC")
	lim := Limits{Hourly: 2, Concurrent: 3}
	mk := func(id string) api.Ticket { return api.Ticket{ID: api.TicketID(id), CreatedAt: now} }
	tests := []struct {
		name   string
		sched  Schedule
		active []api.Ticket
		want   Outcome
	}{
		{"run", night, nil, Run},
		{"outside schedule", day, nil, OutsideSchedule},
		{"hourly limit", night, []api.Ticket{dep("1", time.Minute, now), dep("2", 59*time.Minute, now)}, HourlyLimit},
		{"old tickets do not count hourly", night, []api.Ticket{dep("1", 2*time.Hour, now), dep("2", 3*time.Hour, now)}, Run},
		{"concurrent limit", night, []api.Ticket{dep("1", 2*time.Hour, now), dep("2", 3*time.Hour, now), dep("3", 4*time.Hour, now)}, ConcurrentLimit},
		{"other tickets ignored", night, []api.Ticket{mk("x"), mk("y"), mk("z"), mk("w")}, Run},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tr := porttest.NewTracker(tc.active...)
			for _, a := range tc.active {
				_ = tr.SetPhase(context.Background(), a.ID, api.PhaseRunning)
			}
			got, err := Decide(context.Background(), tr, tc.sched, lim, now)
			if err != nil || got != tc.want {
				t.Errorf("got %v %v, want %v", got, err, tc.want)
			}
		})
	}
}

func TestDecideSurvivesRestart(t *testing.T) {
	now := time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC)
	s, _ := ParseSchedule("", "")
	tr := porttest.NewTracker(dep("1", time.Minute, now))
	_ = tr.SetPhase(context.Background(), "1", api.PhaseRunning)
	// A fresh call with no state carried over, as after a daemon restart, still sees the limit.
	if got, _ := Decide(context.Background(), tr, s, Limits{Hourly: 1}, now); got != HourlyLimit {
		t.Errorf("got %v", got)
	}
}

func TestOutcomeStringsAreStable(t *testing.T) {
	want := map[Outcome]string{Run: "run", OutsideSchedule: "outside-schedule", HourlyLimit: "hourly-limit", ConcurrentLimit: "concurrent-limit"}
	for o, s := range want {
		if o.String() != s {
			t.Errorf("%d: %q != %q", o, o.String(), s)
		}
	}
}

func TestAutomergeAllowed(t *testing.T) {
	night, _ := ParseSchedule("* 0-5 * * *", "UTC")
	if !AutomergeAllowed(night, time.Date(2026, 11, 12, 3, 0, 0, 0, time.UTC)) || AutomergeAllowed(night, time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)) {
		t.Error("automerge schedule not honoured")
	}
}
