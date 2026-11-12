package mergeq

import (
	"context"
	"errors"
	"time"
)

// TimeoutLog is the log tail recorded when a batch ran past Config.BatchTimeout.
const TimeoutLog = "mergeq: batch timed out"

// Outcome is what the queue does after a green batch is pushed.
type Outcome string

// The outcomes of a push, from bors-ng's complete_batch table.
const (
	OutcomeLanded     Outcome = "landed"      // pushed
	OutcomeRetryBatch Outcome = "retry-batch" // not a fast-forward: the gate passed, so test the whole batch again without bisecting
	OutcomeFail       Outcome = "fail"        // anything else: retrying would not change it
)

// PushOutcome classifies the error from Git.FastForward.
func PushOutcome(err error) Outcome {
	switch {
	case err == nil:
		return OutcomeLanded
	case errors.Is(err, ErrBaseMoved):
		return OutcomeRetryBatch
	}
	return OutcomeFail
}

// Backoff is the wait before retry number attempt (from 0): base doubled each time, never above limit.
func Backoff(attempt int, base, limit time.Duration) time.Duration {
	d := base
	for range attempt {
		if d >= limit {
			break
		}
		d *= 2
	}
	return min(d, limit)
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
