package mergeq

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
)

var errBoom = errors.New("push rejected: protected branch")

// Branches of the push outcome table (bors complete_batch): ok, non-ff retries the whole batch,
// anything else fails without a retry.
func TestPushOutcome(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want Outcome
	}{
		{"pushed", nil, OutcomeLanded},
		{"base moved retries the batch", fmt.Errorf("x: %w", ErrBaseMoved), OutcomeRetryBatch},
		{"unknown error fails", errBoom, OutcomeFail},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := PushOutcome(tc.err); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestBackoffIsCapped(t *testing.T) {
	base, limit := time.Second, 5*time.Second
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 5 * time.Second, 5 * time.Second}
	for i, w := range want {
		if got := Backoff(i, base, limit); got != w {
			t.Fatalf("attempt %d: got %v want %v", i, got, w)
		}
	}
	if got := Backoff(200, base, limit); got != limit {
		t.Fatalf("huge attempt: got %v", got)
	}
}

// failFF fails the first n fast-forwards with err, then delegates.
type failFF struct {
	*world
	n   int
	err error
	ffs int
}

func (f *failFF) FastForward(ctx context.Context, ref string) error {
	f.ffs++
	if f.n > 0 {
		f.n--
		return f.err
	}
	return f.world.FastForward(ctx, ref)
}

// A non-ff push retries the whole batch: it lands in the end without a bisect and without an eject,
// and the wait between retries is the capped backoff.
func TestRunNonFFRetriesWholeBatch(t *testing.T) {
	w := newWorld(3)
	g := &failFF{world: w, n: 2, err: ErrBaseMoved}
	var slept []time.Duration
	r := &Runner{Git: g, Gate: w, Store: w, Cfg: Config{BatchSize: 3, PushBackoff: time.Second, PushBackoffMax: 1500 * time.Millisecond}, Sleep: func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil }}
	rep, err := r.Run(context.Background())
	if err != nil || len(rep.Ejected) != 0 || !slices.Equal(landedOrder(w), []string{"1", "2", "3"}) {
		t.Fatalf("err=%v rep=%+v landed=%v", err, rep, landedOrder(w))
	}
	if g.ffs != 3 {
		t.Fatalf("%d pushes, want 3", g.ffs)
	}
	if want := []time.Duration{time.Second, 1500 * time.Millisecond}; !slices.Equal(slept, want) {
		t.Fatalf("slept %v want %v", slept, want)
	}
}

// An unknown push error stops the run, is not retried and ejects nobody.
func TestRunUnknownPushErrorDoesNotRetry(t *testing.T) {
	w := newWorld(2)
	g := &failFF{world: w, n: 5, err: errBoom}
	r := &Runner{Git: g, Gate: w, Store: w, Cfg: Config{BatchSize: 2}, Sleep: func(context.Context, time.Duration) error { return nil }}
	rep, err := r.Run(context.Background())
	if !errors.Is(err, errBoom) || g.ffs != 1 || len(rep.Ejected) != 0 || len(rep.Landed) != 0 {
		t.Fatalf("err=%v pushes=%d rep=%+v", err, g.ffs, rep)
	}
}

// slowGate blocks until its context ends when the ref holds a bad PR.
type slowGate struct{ *world }

func (s slowGate) Run(ctx context.Context, ref string) (Verdict, error) {
	for id := range s.refs[ref].set {
		if s.bad[id] {
			<-ctx.Done()
			return Verdict{}, ctx.Err()
		}
	}
	return s.world.Run(ctx, ref)
}

// A batch that exceeds the per-batch timeout is a red result: it bisects to the culprit like a CI failure.
func TestRunBatchTimeoutSplitsLikeCIFailure(t *testing.T) {
	w := newWorld(4, 3)
	r := &Runner{Git: w, Gate: slowGate{w}, Store: w, Cfg: Config{BatchSize: 4, BatchTimeout: 20 * time.Millisecond}}
	rep, err := r.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(landedOrder(w), []string{"1", "2", "4"}) || len(rep.Ejected) != 1 || rep.Ejected[0].ID != "3" {
		t.Fatalf("landed %v ejected %+v", landedOrder(w), rep.Ejected)
	}
	if rep.Ejected[0].LogTail != TimeoutLog {
		t.Fatalf("log %q", rep.Ejected[0].LogTail)
	}
}

// A cancelled run is not a timeout: the context error comes back.
func TestRunCancelIsNotATimeout(t *testing.T) {
	w := newWorld(2, 1)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	r := &Runner{Git: w, Gate: slowGate{w}, Store: w, Cfg: Config{BatchSize: 2, BatchTimeout: time.Hour}}
	if _, err := r.Run(ctx); !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v", err)
	}
}

// A push that is never a fast-forward is capped: the batch is parked as failed with the reason, the
// attempts stop at the cap, and a zero backoff does not turn the retries into a spin.
func TestRunNonFFIsCappedAndParked(t *testing.T) {
	for _, attempts := range []int{0, 3} { // 0 is the default
		want := attempts
		if want == 0 {
			want = DefaultPushAttempts
		}
		w := newWorld(2)
		g := &failFF{world: w, n: 1 << 30, err: ErrBaseMoved}
		r := &Runner{Git: g, Gate: w, Store: w, Cfg: Config{BatchSize: 2, PushAttempts: attempts}, Sleep: func(context.Context, time.Duration) error { return nil }}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		rep, err := r.Run(ctx)
		cancel()
		if err != nil {
			t.Fatalf("attempts %d: %v", attempts, err)
		}
		if g.ffs != want || len(rep.Landed) != 0 || len(rep.Ejected) != 2 {
			t.Fatalf("attempts %d: pushes=%d rep=%+v, want %d pushes and the batch ejected", attempts, g.ffs, rep, want)
		}
		for _, e := range rep.Ejected {
			if !strings.Contains(e.LogTail, "not a fast-forward") || !strings.Contains(e.LogTail, fmt.Sprint(want)) {
				t.Fatalf("reason %q", e.LogTail)
			}
		}
	}
}
