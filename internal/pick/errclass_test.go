package pick

import (
	"errors"
	"fmt"
	"testing"
	"time"
)

func TestClassify(t *testing.T) {
	plain := errors.New("boom")
	cases := []struct {
		name string
		err  error
		want Class
	}{
		{"nil is retryable", nil, Retryable},
		{"plain error is retryable", plain, Retryable},
		{"terminal", Terminal(plain), ClassTerminal},
		{"wrapped terminal", fmt.Errorf("ctx: %w", Terminal(plain)), ClassTerminal},
		{"rate limited", RateLimited(plain, time.Minute), ClassRateLimited},
		{"wrapped rate limited", fmt.Errorf("ctx: %w", RateLimited(plain, 0)), ClassRateLimited},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Classify(c.err); got != c.want {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}

func TestRetryAfter(t *testing.T) {
	if d, ok := RetryAfter(RateLimited(errors.New("x"), 7*time.Second)); !ok || d != 7*time.Second {
		t.Fatalf("got %v %v", d, ok)
	}
	if _, ok := RetryAfter(errors.New("x")); ok {
		t.Fatal("plain error has no retry-after")
	}
}

func TestSilent(t *testing.T) {
	start := time.Unix(1000, 0)
	cases := []struct {
		name      string
		beat      time.Time
		now       time.Time
		beatEvery time.Duration
		hard      time.Duration
		want      bool
	}{
		{"fresh beat", start.Add(50 * time.Second), start.Add(60 * time.Second), time.Minute, time.Hour, false},
		{"silent past heartbeat", start, start.Add(2 * time.Minute), time.Minute, time.Hour, true},
		{"never beat counts from start", time.Time{}, start.Add(2 * time.Minute), time.Minute, time.Hour, true},
		{"heartbeat off", start, start.Add(2 * time.Hour), 0, time.Hour, false},
		{"heartbeat must be under hard timeout", start, start.Add(2 * time.Hour), 2 * time.Hour, time.Hour, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Silent(start, c.beat, c.now, c.beatEvery, c.hard); got != c.want {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}
