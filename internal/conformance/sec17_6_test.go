package conformance

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// Section 14.2: tracker and observer failures reach the operator and leave state as it was.
func Test17_6_ErrorsReachOperator(t *testing.T) {
	w := newWorld(t, reconcile.Config{MaxConcurrent: 2}, tk("x", 1, t0))
	w.tr.err = errBoom
	w.tick()
	if len(w.errs) != 1 || !errors.Is(w.errs[0], errBoom) || w.state != nil {
		t.Fatalf("errors %v, state %v; want the tracker error reported and no state built", w.errs, w.state)
	}
	if got := w.l.all(); !slices.Equal(got, []string{"tracker.Ready"}) {
		t.Fatalf("calls %v after a failed candidate fetch, want only the read", got)
	}

	w.tr.err = nil
	w.tick()
	before, _ := w.entry("x")
	w.ob.err = errBoom
	w.errs = nil
	w.advance(time.Second)
	w.tick()
	after, ok := w.entry("x")
	if len(w.errs) == 0 || !ok || after.Phase != api.PhaseRunning || after.Attempt != before.Attempt || len(w.dp.Cancels) != 0 {
		t.Fatalf("errors %v, entry %+v; want the observer error reported and the run kept", w.errs, after)
	}
}
