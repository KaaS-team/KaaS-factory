package browsercheck

import (
	"errors"
	"testing"
	"time"
)

// fakeEnv is a settleEnv on a fake clock: waiting advances it, so no test sleeps.
type fakeEnv struct {
	at    time.Duration
	probe func(at time.Duration) (probeState, error)
	net   func(at time.Duration) (pending int, sinceLast time.Duration)
}

func (f *fakeEnv) now() time.Duration            { return f.at }
func (f *fakeEnv) wait(d time.Duration)          { f.at += d }
func (f *fakeEnv) probeDoc() (probeState, error) { return f.probe(f.at) }
func (f *fakeEnv) network() (int, time.Duration) {
	if f.net == nil {
		return 0, time.Hour
	}
	return f.net(f.at)
}

func readyAfter(ready, lastChange time.Duration) func(time.Duration) (probeState, error) {
	return func(at time.Duration) (probeState, error) {
		if at < ready {
			return probeState{Loading: true}, nil
		}
		return probeState{Idle: at - lastChange}, nil
	}
}

// TestSettleConditions has a row for each branch of Settle: the ready, quiet and network
// conditions, the navigation cap extension, and the cap.
func TestSettleConditions(t *testing.T) {
	all := Conditions{Ready: true, Quiet: true, Network: true}
	tests := []struct {
		name    string
		env     *fakeEnv
		cond    Conditions
		cap     time.Duration
		wantWhy string
		wantMin time.Duration
		wantMax time.Duration
	}{
		{"quiet page settles after quiet window", &fakeEnv{probe: readyAfter(0, 0)}, all, time.Second, "quiet", 80 * time.Millisecond, 200 * time.Millisecond},
		{"never quiet hits cap", &fakeEnv{probe: func(time.Duration) (probeState, error) { return probeState{Idle: 0}, nil }}, all, 300 * time.Millisecond, "cap", 300 * time.Millisecond, 400 * time.Millisecond},
		{"loading extends the cap to the navigation limit", &fakeEnv{probe: readyAfter(2*time.Second, 0)}, all, 300 * time.Millisecond, "quiet", 2 * time.Second, 3 * time.Second},
		{"pending request blocks until it finishes", &fakeEnv{
			probe: readyAfter(0, -time.Hour),
			net: func(at time.Duration) (int, time.Duration) {
				if at < 500*time.Millisecond {
					return 1, 0
				}
				return 0, time.Hour
			}}, all, time.Second, "quiet", 500 * time.Millisecond, 700 * time.Millisecond},
		{"network off ignores a pending request", &fakeEnv{probe: readyAfter(0, -time.Hour), net: func(time.Duration) (int, time.Duration) { return 5, 0 }}, Conditions{Ready: true, Quiet: true}, time.Second, "quiet", 0, 100 * time.Millisecond},
		{"quiet off ignores DOM churn", &fakeEnv{probe: func(time.Duration) (probeState, error) { return probeState{Idle: 0}, nil }}, Conditions{Ready: true, Network: true}, time.Second, "quiet", 0, 100 * time.Millisecond},
		{"ready off ignores loading", &fakeEnv{probe: func(time.Duration) (probeState, error) { return probeState{Loading: true, Idle: time.Hour}, nil }}, Conditions{Quiet: true}, time.Second, "quiet", 0, 100 * time.Millisecond},
		{"probe error during navigation retries then caps", &fakeEnv{probe: func(time.Duration) (probeState, error) { return probeState{}, errors.New("context destroyed") }}, all, 300 * time.Millisecond, "cap", 300 * time.Millisecond, 400 * time.Millisecond},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := Settle(tt.env, tt.cond, tt.cap, 80*time.Millisecond, 0)
			if got.Why != tt.wantWhy {
				t.Fatalf("why = %q, want %q (%+v)", got.Why, tt.wantWhy, got)
			}
			if got.Took < tt.wantMin || got.Took > tt.wantMax {
				t.Errorf("took %v, want within [%v, %v]", got.Took, tt.wantMin, tt.wantMax)
			}
		})
	}
}

// TestSettleSinceCountsActionTime checks that DOM quiet before the action began does not count.
func TestSettleSinceCountsActionTime(t *testing.T) {
	// the action began 50 ms before Settle was called; 80 ms of quiet must pass after it
	env := &fakeEnv{at: time.Second, probe: func(time.Duration) (probeState, error) { return probeState{Idle: time.Hour}, nil }}
	got := Settle(env, Conditions{Ready: true, Quiet: true}, time.Second, 80*time.Millisecond, 950*time.Millisecond)
	if got.Why != "quiet" || got.Took < 30*time.Millisecond {
		t.Errorf("settled at %v (%s) before the quiet window after the action", got.Took, got.Why)
	}
}

func TestNetTracker(t *testing.T) {
	tr := &netTracker{inflight: map[string]time.Duration{}}
	tr.start("a", 0)
	tr.start("b", 100*time.Millisecond)
	if n, _ := tr.snapshot(200 * time.Millisecond); n != 2 {
		t.Errorf("pending = %d, want 2", n)
	}
	tr.done("a", 300*time.Millisecond)
	if n, since := tr.snapshot(350 * time.Millisecond); n != 1 || since != 50*time.Millisecond {
		t.Errorf("pending %d since %v, want 1 and 50ms", n, since)
	}
	// a request older than 1.5 s is a long poll, not pending
	if n, _ := tr.snapshot(2 * time.Second); n != 0 {
		t.Errorf("stale request still pending: %d", n)
	}
}
