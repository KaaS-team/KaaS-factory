package pick

import (
	"errors"
	"time"
)

// Class says how a failed attempt should be treated.
type Class int

// The error classes. An error with no class is Retryable.
const (
	Retryable Class = iota
	ClassTerminal
	ClassRateLimited
)

type classed struct {
	error
	class Class
	after time.Duration
}

func (c classed) Unwrap() error { return c.error }

// Terminal marks err as one no retry can fix, so the ticket is parked at once.
func Terminal(err error) error { return classed{err, ClassTerminal, 0} }

// RateLimited marks err as a throttle; after is the wait the upstream asked for, 0 if none.
func RateLimited(err error, after time.Duration) error {
	return classed{err, ClassRateLimited, after}
}

// Classify returns the class of err; nil and unmarked errors are Retryable.
func Classify(err error) Class {
	var c classed
	if errors.As(err, &c) {
		return c.class
	}
	return Retryable
}

// RetryAfter returns the wait a RateLimited error carries.
func RetryAfter(err error) (time.Duration, bool) {
	var c classed
	if errors.As(err, &c) && c.class == ClassRateLimited {
		return c.after, true
	}
	return 0, false
}

// Silent reports whether a session sent no heartbeat for longer than every, so it can be
// killed before the hard timeout. started stands in when it never beat. It is false when
// every is zero or not shorter than hard.
func Silent(started, lastBeat, now time.Time, every, hard time.Duration) bool {
	if every <= 0 || (hard > 0 && every >= hard) {
		return false
	}
	if lastBeat.IsZero() {
		lastBeat = started
	}
	return now.Sub(lastBeat) > every
}
