package shadow_test

import (
	"context"
	"testing"

	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/dispatch/shadow"
)

// TestWrap: with shadow on the inner dispatcher is never called and the brief is recorded; with
// it off Wrap returns the inner dispatcher itself (Symphony 7.4 keeps dispatch per attempt).
func TestWrap(t *testing.T) {
	inner := &countingInner{Dispatcher: porttest.NewDispatcher(2), t: t}
	w := &memWriter{}

	off := shadow.Wrap(inner, config.Config{}, w)
	if off != inner {
		t.Fatalf("shadow off must return the inner dispatcher")
	}

	on := shadow.Wrap(inner, config.Config{Shadow: true}, w)
	if on.Name() != "shadow:fake" {
		t.Fatalf("name = %q", on.Name())
	}
	if _, err := on.Dispatch(context.Background(), brief("9", 1)); err != nil {
		t.Fatal(err)
	}
	if inner.calls != 0 || len(w.recs) != 1 || w.recs[0].Brief == nil || w.recs[0].Brief.Ticket != "9" {
		t.Fatalf("calls=%d records=%+v", inner.calls, w.recs)
	}
}
