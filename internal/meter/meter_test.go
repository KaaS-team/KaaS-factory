package meter

import (
	"errors"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var k = Key{Team: "t", Ticket: "7", Node: "build", Session: "factory-7-a1"}

func fixedClock(t time.Time) func() time.Time { return func() time.Time { return t } }

// Symphony §13.5: absolute totals in, deltas derived, never double counted.
func TestRecordDerivesDeltasFromAbsoluteTotals(t *testing.T) {
	rows := []struct {
		name  string
		total api.Usage
		delta api.Usage
	}{
		{"first total is all delta", api.Usage{InputTokens: 100, OutputTokens: 10, WallTime: time.Second}, api.Usage{InputTokens: 100, OutputTokens: 10, WallTime: time.Second}},
		{"same total twice adds zero", api.Usage{InputTokens: 100, OutputTokens: 10, WallTime: time.Second}, api.Usage{}},
		{"growth adds the difference", api.Usage{InputTokens: 250, OutputTokens: 40, CacheReadTokens: 5, WallTime: 3 * time.Second}, api.Usage{InputTokens: 150, OutputTokens: 30, CacheReadTokens: 5, WallTime: 2 * time.Second}},
		{"only cost moves", api.Usage{InputTokens: 250, OutputTokens: 40, CacheReadTokens: 5, WallTime: 3 * time.Second, CostUSD: 0.5}, api.Usage{CostUSD: 0.5}},
		{"cost zero means unknown, keeps the last", api.Usage{InputTokens: 260, OutputTokens: 40, CacheReadTokens: 5, WallTime: 3 * time.Second}, api.Usage{InputTokens: 10}},
	}
	m := New(Budgets{}, time.Now)
	var sum api.Usage
	var last api.Usage
	for _, r := range rows {
		got, err := m.Record(k, r.total)
		if err != nil {
			t.Fatalf("%s: %v", r.name, err)
		}
		if got != r.delta {
			t.Errorf("%s: delta = %+v, want %+v", r.name, got, r.delta)
		}
		sum = add(sum, got)
		last = r.total
	}
	last.CostUSD = 0.5 // unknown cost keeps the last known value
	if sum != last {
		t.Errorf("deltas sum to %+v, last total is %+v", sum, last)
	}
}

func TestRecordRejectsATotalThatGoesDown(t *testing.T) {
	base := api.Usage{InputTokens: 100, OutputTokens: 50, CacheReadTokens: 4, CacheWriteTokens: 3, CostUSD: 1, WallTime: time.Minute}
	rows := []struct {
		name string
		mut  func(*api.Usage)
	}{
		{"input", func(u *api.Usage) { u.InputTokens-- }},
		{"output", func(u *api.Usage) { u.OutputTokens-- }},
		{"cache read", func(u *api.Usage) { u.CacheReadTokens-- }},
		{"cache write", func(u *api.Usage) { u.CacheWriteTokens-- }},
		{"cost", func(u *api.Usage) { u.CostUSD = 0.5 }},
		{"wall time", func(u *api.Usage) { u.WallTime-- }},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			m := New(Budgets{}, time.Now)
			if _, err := m.Record(k, base); err != nil {
				t.Fatal(err)
			}
			lower := base
			r.mut(&lower)
			if _, err := m.Record(k, lower); !errors.Is(err, ErrTotalDecreased) {
				t.Fatalf("err = %v, want ErrTotalDecreased", err)
			}
			// The bad total changed nothing.
			if d, err := m.Record(k, base); err != nil || d != (api.Usage{}) {
				t.Errorf("after a rejected total: delta %+v err %v", d, err)
			}
		})
	}
}

func TestSessionsOfOneNodeAddUp(t *testing.T) {
	m := New(Budgets{Node: api.Budget{Tokens: 1000}}, time.Now)
	a1 := Key{Team: "t", Ticket: "7", Node: "build", Session: "a1"}
	a2 := Key{Team: "t", Ticket: "7", Node: "build", Session: "a2"}
	if _, err := m.Record(a1, api.Usage{InputTokens: 400}); err != nil {
		t.Fatal(err)
	}
	// A new attempt starts again from zero without tripping the decrease check.
	if _, err := m.Record(a2, api.Usage{InputTokens: 100}); err != nil {
		t.Fatal(err)
	}
	if got := m.Used(a2).Node.InputTokens; got != 500 {
		t.Errorf("node tokens = %d, want 500", got)
	}
}

// The thresholds: 79% ok, 80% steer, 100% stop, at every level and for every dimension.
func TestCheckThresholds(t *testing.T) {
	day := time.Date(2026, 11, 12, 9, 0, 0, 0, time.UTC)
	levels := []struct {
		name   string
		budget func(api.Budget) Budgets
	}{
		{"node", func(b api.Budget) Budgets { return Budgets{Node: b} }},
		{"ticket", func(b api.Budget) Budgets { return Budgets{Ticket: b} }},
		{"team-day", func(b api.Budget) Budgets { return Budgets{TeamDay: b} }},
	}
	dims := []struct {
		name  string
		cap   api.Budget
		usage func(pct int64) api.Usage
	}{
		{"tokens", api.Budget{Tokens: 1000}, func(p int64) api.Usage { return api.Usage{InputTokens: p * 5, OutputTokens: p * 5} }},
		{"usd", api.Budget{USD: 100}, func(p int64) api.Usage { return api.Usage{CostUSD: float64(p)} }},
		{"wall", api.Budget{WallClock: 100 * time.Minute}, func(p int64) api.Usage { return api.Usage{WallTime: time.Duration(p) * time.Minute} }},
	}
	steps := []struct {
		pct  int64
		want Verdict
	}{{0, OK}, {79, OK}, {80, Steer}, {99, Steer}, {100, Stop}, {150, Stop}}
	for _, l := range levels {
		for _, d := range dims {
			for _, s := range steps {
				m := New(l.budget(d.cap), fixedClock(day))
				if s.pct > 0 {
					if _, err := m.Record(k, d.usage(s.pct)); err != nil {
						t.Fatal(err)
					}
				}
				if got := m.Check(k); got != s.want {
					t.Errorf("%s/%s at %d%%: %s, want %s", l.name, d.name, s.pct, got, s.want)
				}
			}
		}
	}
}

func TestCheckUsesTheTightestBudget(t *testing.T) {
	m := New(Budgets{
		Node:    api.Budget{Tokens: 1000},
		Ticket:  api.Budget{Tokens: 200}, // 100 used is 50% here, 10% of the node cap
		TeamDay: api.Budget{USD: 10},
	}, time.Now)
	if _, err := m.Record(k, api.Usage{InputTokens: 100, CostUSD: 8}); err != nil {
		t.Fatal(err)
	}
	if got := m.Check(k); got != Steer {
		t.Errorf("tightest is team-day at 80%%: got %s", got)
	}
	if got := m.Check(Key{Team: "t", Ticket: "8", Node: "x", Session: "s"}); got != Steer {
		t.Errorf("another ticket shares the team-day budget: got %s", got)
	}
}

func TestTeamDayResetsAtUTCMidnightAndTeamsAreSeparate(t *testing.T) {
	now := time.Date(2026, 11, 12, 23, 0, 0, 0, time.UTC)
	m := New(Budgets{TeamDay: api.Budget{USD: 10}}, func() time.Time { return now })
	if _, err := m.Record(k, api.Usage{CostUSD: 10}); err != nil {
		t.Fatal(err)
	}
	if got := m.Check(k); got != Stop {
		t.Fatalf("same day: %s", got)
	}
	other := Key{Team: "u", Ticket: "7", Node: "build", Session: "s"}
	if got := m.Check(other); got != OK {
		t.Errorf("other team: %s", got)
	}
	now = now.Add(2 * time.Hour)
	if got := m.Check(k); got != OK {
		t.Errorf("next day: %s", got)
	}
	// Spend recorded after midnight lands on the new day as a delta.
	if _, err := m.Record(k, api.Usage{CostUSD: 12}); err != nil {
		t.Fatal(err)
	}
	if got := m.Used(k).TeamDay.CostUSD; got != 2 {
		t.Errorf("new day spend = %v, want 2", got)
	}
}

func TestNoBudgetIsAlwaysOK(t *testing.T) {
	m := New(Budgets{}, time.Now)
	if _, err := m.Record(k, api.Usage{InputTokens: 1 << 40, CostUSD: 1e6, WallTime: time.Hour * 1000}); err != nil {
		t.Fatal(err)
	}
	if got := m.Check(k); got != OK {
		t.Errorf("got %s", got)
	}
}
