package core

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var _ api.Historian = (*Core)(nil)

func seqOf(evs []api.Event) []int {
	out := make([]int, len(evs))
	for i, e := range evs {
		out[i] = e.Data["n"].(int)
	}
	return out
}

func TestHistoryKeepsLast500InOrderAndTicketsDoNotMix(t *testing.T) {
	h := newHub(4, func() time.Time { return t0 })
	for i := 0; i < 600; i++ {
		h.emit(KindPushed, "A", map[string]any{"n": i})
		if i < 3 {
			h.emit(KindPushed, "B", map[string]any{"n": 1000 + i})
		}
	}
	h.emit(KindTick, "", map[string]any{"n": -1})
	c := &Core{hub: h}

	a, err := c.History(context.Background(), "A")
	if err != nil {
		t.Fatal(err)
	}
	if len(a) != HistoryLimit {
		t.Fatalf("A kept %d events, want %d", len(a), HistoryLimit)
	}
	for i, n := range seqOf(a) {
		if n != 100+i {
			t.Fatalf("A[%d] = %d, want %d", i, n, 100+i)
		}
	}
	b, _ := c.History(context.Background(), "B")
	if fmt.Sprint(seqOf(b)) != "[1000 1001 1002]" {
		t.Fatalf("B = %v", seqOf(b))
	}
	if none, _ := c.History(context.Background(), "ghost"); len(none) != 0 {
		t.Fatalf("unknown ticket has %d events", len(none))
	}
	// The returned slice is a copy: changing it must not change the log.
	a[0].Kind = "mutated"
	again, _ := c.History(context.Background(), "A")
	if again[0].Kind != KindPushed {
		t.Fatal("History returned the internal slice")
	}
}
