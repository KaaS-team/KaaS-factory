package serve

import (
	"context"
	"testing"
	"time"
)

func TestJitterOffset(t *testing.T) {
	nominal := time.Date(2026, 1, 1, 10, 5, 0, 0, time.UTC)
	w := 30 * time.Second
	if a, b := JitterOffset(nominal, w, "a"), JitterOffset(nominal, w, "a"); a != b {
		t.Fatalf("not deterministic: %v vs %v", a, b)
	}
	seen := map[time.Duration]bool{}
	for _, id := range []string{"a", "b", "c", "d", "e", "f", "g", "h"} {
		o := JitterOffset(nominal, w, id)
		if o < 0 || o > w {
			t.Fatalf("%s: offset %v outside [0, %v]", id, o, w)
		}
		seen[o] = true
	}
	if len(seen) < 4 {
		t.Fatalf("instances do not spread: %d distinct offsets of 8", len(seen))
	}
	if JitterOffset(nominal, 0, "a") != 0 {
		t.Fatal("zero window must give zero offset")
	}
}

// Ported from go/k10-catchup internal/serve/schedule.go: a tick starts up to the jitter window
// before its nominal time, so teammates on one cron do not fire together.
func TestJobs_JitterStartsATickEarlyButOncePerPeriod(t *testing.T) {
	ctx := context.Background()
	w := 30 * time.Second
	nominal := time.Date(2026, 1, 1, 10, 5, 0, 0, time.UTC)
	off := JitterOffset(nominal, w, "me")
	if off < time.Second {
		t.Skipf("offset %v too small to observe", off)
	}
	clk := &fakeClock{t: nominal.Add(-time.Minute)}
	j, _ := openJobs(t, "", clk)
	j.SetJitter(w, "me")
	if err := j.Add(ctx, "a", "*/5 * * * *"); err != nil {
		t.Fatal(err)
	}
	clk.Add(time.Minute - off - time.Millisecond) // just before the jittered start
	_ = j.Tick(ctx)
	if got := runCount(t, j, "a"); got != 0 {
		t.Fatalf("fired %v before its jittered start: %d runs", off, got)
	}
	clk.Add(2 * time.Millisecond) // at the jittered start, still before the nominal tick
	_ = j.Tick(ctx)
	if got := runCount(t, j, "a"); got != 1 {
		t.Fatalf("not fired at its jittered start: %d runs", got)
	}
	clk.Add(off) // past the nominal tick: same period, no second run
	_ = j.Tick(ctx)
	if got := runCount(t, j, "a"); got != 1 {
		t.Fatalf("second run for one period: %d runs", got)
	}
}
