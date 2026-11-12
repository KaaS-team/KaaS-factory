package sandbox

import (
	"testing"
	"time"
)

// Symphony section 8.5 (reconciliation): a session that outlives its limits is stopped, never left running.
func TestPolicyDecide(t *testing.T) {
	t0 := time.Unix(1000, 0)
	min := time.Minute
	tests := []struct {
		name string
		p    Policy
		now  time.Duration // since start
		idle time.Duration // since last activity
		fg   int
		want Verdict
	}{
		{"no timeouts never reclaims", Policy{}, 1000 * time.Hour, 1000 * time.Hour, 0, Keep},
		{"under max duration", Policy{MaxDuration: 10 * min}, 9 * min, 9 * min, 1, Keep},
		{"killed at max duration", Policy{MaxDuration: 10 * min}, 10 * min, 0, 1, KillMaxDuration},
		{"idle past timeout reclaimed", Policy{IdleTimeout: 5 * min}, 20 * min, 5 * min, 0, ReclaimIdle},
		{"idle under timeout kept", Policy{IdleTimeout: 5 * min}, 20 * min, 4 * min, 0, Keep},
		{"foreground exec blocks idle", Policy{IdleTimeout: 5 * min}, 20 * min, 50 * min, 1, Keep},
		{"max duration wins over idle", Policy{MaxDuration: 10 * min, IdleTimeout: 5 * min}, 10 * min, 9 * min, 0, KillMaxDuration},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			now := t0.Add(tc.now)
			if got := tc.p.Decide(now, t0, now.Add(-tc.idle), tc.fg); got != tc.want {
				t.Fatalf("Decide = %v, want %v", got, tc.want)
			}
		})
	}
}

// Detached children are not foreground execs, so they never reach the counter.
func TestActivityIgnoresDetached(t *testing.T) {
	t0 := time.Unix(1000, 0)
	a := NewActivity(t0)
	end := a.Begin(t0.Add(time.Minute))
	if _, fg := a.Snapshot(); fg != 1 {
		t.Fatalf("foreground = %d, want 1", fg)
	}
	end(t0.Add(2 * time.Minute))
	last, fg := a.Snapshot()
	if fg != 0 || !last.Equal(t0.Add(2*time.Minute)) {
		t.Fatalf("after end: last=%v fg=%d", last, fg)
	}
}

func TestMaxDurationKillsChild(t *testing.T) {
	spec := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true, Policy: Policy{MaxDuration: 300 * time.Millisecond}}
	start := time.Now()
	if _, code := run(t, spec, "sleep", "30"); code == 0 || time.Since(start) > 10*time.Second {
		t.Fatalf("child not stopped at MaxDuration (exit %d after %v)", code, time.Since(start))
	}
}
