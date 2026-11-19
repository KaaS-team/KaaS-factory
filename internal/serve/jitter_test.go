package serve

import (
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
