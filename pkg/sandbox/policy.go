package sandbox

import (
	"sync"
	"time"
)

// Policy bounds how long a session may live. A zero field disables that bound.
type Policy struct {
	// MaxDuration is the longest a session may run, measured from its start.
	MaxDuration time.Duration
	// IdleTimeout is how long a session may sit with no foreground exec and no activity.
	IdleTimeout time.Duration
	// Ephemeral marks a session whose workdir is discarded when it ends.
	Ephemeral bool
}

// Verdict is what Policy.Decide says to do with a session.
type Verdict int

// The verdicts, in the order Decide checks them.
const (
	Keep Verdict = iota
	KillMaxDuration
	ReclaimIdle
)

// Decide says what to do with a session at now. foreground counts execs the
// caller waits on; detached children are not counted, so they never block idle reclaim.
func (p Policy) Decide(now, start, lastActivity time.Time, foreground int) Verdict {
	switch {
	case p.MaxDuration > 0 && now.Sub(start) >= p.MaxDuration:
		return KillMaxDuration
	case p.IdleTimeout > 0 && foreground == 0 && now.Sub(lastActivity) >= p.IdleTimeout:
		return ReclaimIdle
	}
	return Keep
}

// Activity tracks the last activity time and the foreground exec count for Policy.Decide.
type Activity struct {
	mu   sync.Mutex
	last time.Time
	fg   int
}

// NewActivity starts tracking at now.
func NewActivity(now time.Time) *Activity { return &Activity{last: now} }

// Begin records a foreground exec starting and returns the function that records its end.
func (a *Activity) Begin(now time.Time) (end func(time.Time)) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.last, a.fg = now, a.fg+1
	return func(t time.Time) {
		a.mu.Lock()
		defer a.mu.Unlock()
		a.last, a.fg = t, a.fg-1
	}
}

// Snapshot returns the last activity time and the foreground exec count.
func (a *Activity) Snapshot() (time.Time, int) {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.last, a.fg
}
