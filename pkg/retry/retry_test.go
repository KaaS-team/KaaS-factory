package retry_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/KaaS-team/factory/pkg/retry"
)

const ms = time.Millisecond

func TestExponentialComputeNextDelay(t *testing.T) {
	base := func() *retry.ExponentialRetryPolicy {
		return retry.NewExponentialRetryPolicy(100 * ms).WithMaximumInterval(time.Second).WithExpirationInterval(retry.NoInterval)
	}
	cases := []struct {
		name     string
		p        *retry.ExponentialRetryPolicy
		elapsed  time.Duration
		attempt  int
		lo, hi   time.Duration // jitter bounds: [0.8x, x)
		wantDone bool
	}{
		{"first retry waits the initial interval", base(), 0, 1, 80 * ms, 100 * ms, false},
		{"second retry doubles", base(), 0, 2, 160 * ms, 200 * ms, false},
		{"growth is capped at the maximum interval", base(), 0, 20, 800 * ms, time.Second, false},
		{"max attempts: attempt == max is done", base().WithMaximumAttempts(3), 0, 3, 0, 0, true},
		{"max attempts: one below still retries", base().WithMaximumAttempts(3), 0, 2, 160 * ms, 200 * ms, false},
		{"max attempts 0 means no limit", base().WithMaximumAttempts(0), 0, 1000, 800 * ms, time.Second, false},
		{"expired after the expiration interval", base().WithExpirationInterval(time.Minute), time.Minute + 1, 1, 0, 0, true},
		{"expiry clamps the wait to the time left", retry.NewExponentialRetryPolicy(10 * ms).WithMaximumInterval(time.Second).WithExpirationInterval(time.Second), 950 * ms, 9, 40 * ms, 50 * ms, false},
		{"expiry leaving less than the initial interval is done", base().WithExpirationInterval(time.Second), 950 * ms, 5, 0, 0, true},
		{"negative initial interval never retries", retry.NewExponentialRetryPolicy(-ms), 0, 1, 0, 0, true},
		{"overflow stops instead of wrapping", retry.NewExponentialRetryPolicy(time.Hour).WithMaximumInterval(retry.NoInterval).WithExpirationInterval(retry.NoInterval), 0, 50, 0, 0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			for range 200 { // jitter is random: every draw must stay inside the bounds
				got := c.p.ComputeNextDelay(c.elapsed, c.attempt, nil)
				if c.wantDone {
					if got != retry.Done {
						t.Fatalf("got %v, want Done", got)
					}
					continue
				}
				if got < c.lo || got >= c.hi {
					t.Fatalf("got %v, want in [%v, %v)", got, c.lo, c.hi)
				}
			}
		})
	}
}

// fakeClock advances only when slept on, so expiry is testable without waiting.
type fakeClock struct {
	t      time.Time
	sleeps []time.Duration
}

func (c *fakeClock) now() time.Time { return c.t }
func (c *fakeClock) sleep(_ context.Context, d time.Duration) error {
	c.sleeps = append(c.sleeps, d)
	c.t = c.t.Add(d)
	return nil
}

func TestLoop(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name      string
		policy    retry.RetryPolicy
		failures  int // op fails this many times, then succeeds
		retryable func(error) bool
		minDelay  func(error) time.Duration
		wantCalls int
		wantErr   error
	}{
		{"success first try", retry.NewExponentialRetryPolicy(ms).WithExpirationInterval(retry.NoInterval), 0, nil, nil, 1, nil},
		{"retries until success", retry.NewExponentialRetryPolicy(ms).WithExpirationInterval(retry.NoInterval), 2, nil, nil, 3, nil},
		{"max attempts bounds the calls", retry.NewExponentialRetryPolicy(ms).WithMaximumAttempts(3), 99, nil, nil, 3, boom},
		{"non-retryable error returns at once", retry.NewExponentialRetryPolicy(ms).WithExpirationInterval(retry.NoInterval), 99, func(err error) bool { return !errors.Is(err, boom) }, nil, 1, boom},
		{"one attempt allowed returns the first error", retry.NewExponentialRetryPolicy(ms).WithMaximumAttempts(1), 99, nil, nil, 1, boom},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			clk := &fakeClock{t: time.Unix(0, 0)}
			calls := 0
			err := retry.Loop{Policy: c.policy, IsRetryable: c.retryable, MinDelay: c.minDelay, Now: clk.now, Sleep: clk.sleep}.Do(context.Background(), func(context.Context) error {
				calls++
				if calls <= c.failures {
					return boom
				}
				return nil
			})
			if calls != c.wantCalls || !errors.Is(err, c.wantErr) {
				t.Fatalf("calls = %d err = %v, want %d, %v", calls, err, c.wantCalls, c.wantErr)
			}
		})
	}
}

func TestLoopExpiry(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0)}
	calls := 0
	err := retry.Loop{Policy: retry.NewExponentialRetryPolicy(100 * ms).WithMaximumInterval(100 * ms).WithExpirationInterval(350 * ms), Now: clk.now, Sleep: clk.sleep}.
		Do(context.Background(), func(context.Context) error { calls++; return errors.New("boom") })
	if err == nil || calls < 2 || calls > 5 || clk.t.Sub(time.Unix(0, 0)) > 350*ms {
		t.Fatalf("calls = %d err = %v waited = %v, want a bounded loop within 350ms", calls, err, clk.t.Sub(time.Unix(0, 0)))
	}
}

func TestLoopMinDelayRaisesTheWait(t *testing.T) {
	clk := &fakeClock{t: time.Unix(0, 0)}
	n := 0
	err := retry.Loop{
		Policy:   retry.NewExponentialRetryPolicy(ms).WithExpirationInterval(retry.NoInterval),
		MinDelay: func(error) time.Duration { return 2 * time.Second },
		Now:      clk.now, Sleep: clk.sleep,
	}.Do(context.Background(), func(context.Context) error {
		if n++; n == 1 {
			return errors.New("throttled")
		}
		return nil
	})
	if err != nil || len(clk.sleeps) != 1 || clk.sleeps[0] != 2*time.Second {
		t.Fatalf("err = %v, sleeps = %v, want one 2s sleep", err, clk.sleeps)
	}
}

func TestLoopContext(t *testing.T) {
	boom := errors.New("boom")
	t.Run("cancelled before the first call returns the context error", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		calls := 0
		err := retry.Loop{Policy: retry.NewExponentialRetryPolicy(ms).WithExpirationInterval(retry.NoInterval)}.Do(ctx, func(context.Context) error { calls++; return boom })
		if calls != 0 || !errors.Is(err, context.Canceled) {
			t.Fatalf("calls = %d err = %v", calls, err)
		}
	})
	t.Run("a context error from the op is not retried", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		calls := 0
		err := retry.Loop{Policy: retry.NewExponentialRetryPolicy(ms).WithExpirationInterval(retry.NoInterval)}.Do(ctx, func(ctx context.Context) error {
			calls++
			cancel()
			return ctx.Err()
		})
		if calls != 1 || !errors.Is(err, context.Canceled) {
			t.Fatalf("calls = %d err = %v", calls, err)
		}
	})
	t.Run("cancel during the real wait ends the loop", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		go func() { time.Sleep(10 * ms); cancel() }()
		err := retry.Loop{Policy: retry.NewExponentialRetryPolicy(time.Minute).WithMaximumInterval(time.Minute).WithExpirationInterval(retry.NoInterval)}.Do(ctx, func(context.Context) error { return boom })
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("err = %v", err)
		}
	})
	t.Run("a wait past the deadline is not started and the last error returns", func(t *testing.T) {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		slept := false
		err := retry.Loop{Policy: retry.NewExponentialRetryPolicy(time.Hour).WithMaximumInterval(time.Hour).WithExpirationInterval(retry.NoInterval), Sleep: func(context.Context, time.Duration) error { slept = true; return nil }}.
			Do(ctx, func(context.Context) error { return boom })
		if slept || !errors.Is(err, boom) {
			t.Fatalf("slept = %v err = %v", slept, err)
		}
	})
}
