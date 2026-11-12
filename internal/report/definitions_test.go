package report

import (
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var t0 = time.Date(2026, 11, 2, 9, 0, 0, 0, time.UTC)

func at(h int) time.Time { return t0.Add(time.Duration(h) * time.Hour) }

func TestMerged(t *testing.T) {
	w := Window{Since: at(0), Until: at(100)}
	for _, c := range []struct {
		name string
		mt   time.Time
		want bool
	}{
		{"never merged", time.Time{}, false},
		{"before window", at(-1), false},
		{"at since is inside", at(0), true},
		{"inside", at(50), true},
		{"at until is outside", at(100), false},
		{"after window", at(101), false},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := Merged(TicketRecord{MergedAt: c.mt}, w); got != c.want {
				t.Fatalf("Merged = %v, want %v", got, c.want)
			}
		})
	}
}

func TestTokens(t *testing.T) {
	// hand computed: 100 + 20 + 300 + 5 = 425
	u := api.Usage{InputTokens: 100, OutputTokens: 20, CacheReadTokens: 300, CacheWriteTokens: 5}
	if got := Tokens(u); got != 425 {
		t.Fatalf("Tokens = %d, want 425", got)
	}
}

func TestTicketTokensCountsFailedAttempts(t *testing.T) {
	r := TicketRecord{Attempts: []Attempt{
		{N: 1, Usage: api.Usage{InputTokens: 1000, OutputTokens: 200}}, // failed attempt
		{N: 2, Usage: api.Usage{InputTokens: 500, OutputTokens: 100}},
	}}
	if got := TicketTokens(r); got != 1800 {
		t.Fatalf("TicketTokens = %d, want 1800", got)
	}
}

func TestRework(t *testing.T) {
	for _, c := range []struct {
		name     string
		attempts []int
		want     int
	}{
		{"no attempts", nil, 0},
		{"one attempt", []int{1}, 0},
		{"two attempts", []int{1, 2}, 1},
		{"four attempts", []int{1, 2, 3, 4}, 3},
	} {
		t.Run(c.name, func(t *testing.T) {
			var r TicketRecord
			for _, n := range c.attempts {
				r.Attempts = append(r.Attempts, Attempt{N: n})
			}
			if got := Rework(r); got != c.want {
				t.Fatalf("Rework = %d, want %d", got, c.want)
			}
		})
	}
}

func TestHumanTouches(t *testing.T) {
	for _, c := range []struct {
		name string
		r    TicketRecord
		want int
	}{
		{"none", TicketRecord{}, 0},
		{"chatops only", TicketRecord{ChatopsCommands: 2}, 2},
		{"pushes only", TicketRecord{ManualPushes: 3}, 3},
		{"both", TicketRecord{ChatopsCommands: 1, ManualPushes: 4}, 5},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := HumanTouches(c.r); got != c.want {
				t.Fatalf("HumanTouches = %d, want %d", got, c.want)
			}
		})
	}
}

func TestCycleTime(t *testing.T) {
	for _, c := range []struct {
		name   string
		r      TicketRecord
		want   time.Duration
		wantOK bool
	}{
		{"never merged", TicketRecord{FirstDispatch: at(1)}, 0, false},
		{"never dispatched", TicketRecord{MergedAt: at(5)}, 0, false},
		{"merge before dispatch", TicketRecord{FirstDispatch: at(5), MergedAt: at(1)}, 0, false},
		{"six hours", TicketRecord{FirstDispatch: at(1), MergedAt: at(7)}, 6 * time.Hour, true},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, ok := CycleTime(c.r)
			if got != c.want || ok != c.wantOK {
				t.Fatalf("CycleTime = %v,%v want %v,%v", got, ok, c.want, c.wantOK)
			}
		})
	}
}
