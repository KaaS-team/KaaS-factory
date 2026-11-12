// Ported from temporalio/temporal@bfabec7 common/backoff/retry.go

// Package retry is a small retry and backoff kit forked from temporal common/backoff (MIT).
package retry

import (
	"context"
	"errors"
	"time"
)

// Loop runs an operation until it succeeds, the policy says Done, the error is not retryable or the
// context ends. A zero Loop with a Policy uses real time and retries every error.
type Loop struct {
	Policy      RetryPolicy
	IsRetryable func(error) bool                           // nil retries every error
	MinDelay    func(error) time.Duration                  // nil, or a floor on the wait after an error (a server's Retry-After)
	Now         func() time.Time                           // nil is time.Now
	Sleep       func(context.Context, time.Duration) error // nil waits on a timer; an error ends the loop with that error
}

// Do runs op under the loop. Context errors are never retried. It returns nil on success, otherwise
// the last error op returned, or the context's error if op never ran. A wait that would pass the
// context deadline is not started.
func (l Loop) Do(ctx context.Context, op func(context.Context) error) error {
	now, sleep, retryable := l.Now, l.Sleep, l.IsRetryable
	if now == nil {
		now = time.Now
	}
	if sleep == nil {
		sleep = wait
	}
	if retryable == nil {
		retryable = func(error) bool { return true }
	}
	deadline, hasDeadline := ctx.Deadline()
	r := NewRetrier(l.Policy, now)

	var err error
	for ctx.Err() == nil {
		if err = op(ctx); err == nil {
			return nil
		}
		next := r.NextBackOff(err)
		if next == done || errors.Is(err, ctx.Err()) || !retryable(err) {
			return err
		}
		if l.MinDelay != nil {
			next = max(next, l.MinDelay(err))
		}
		if hasDeadline && now().Add(next).After(deadline) {
			return err
		}
		if serr := sleep(ctx, next); serr != nil {
			return serr
		}
	}
	if err != nil {
		return err
	}
	return ctx.Err()
}

func wait(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}
