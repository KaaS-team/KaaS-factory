package tui

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/KaaS-team/factory/internal/api"
)

const fixture = "../../docs/demo/fleet.ndjson"

func loadReplay(t *testing.T, src string) *Replay {
	t.Helper()
	rp, err := NewReplay(strings.NewReader(src), 0)
	if err != nil {
		t.Fatal(err)
	}
	return rp
}

func fixtureReplay(t *testing.T) *Replay {
	t.Helper()
	b, err := os.ReadFile(fixture)
	if err != nil {
		t.Fatal(err)
	}
	return loadReplay(t, string(b))
}

// replayModel plays the first n recorded events through the model's own reducer.
func replayModel(t *testing.T, rp *Replay, n int, opts ...Option) *Model {
	t.Helper()
	opts = append([]Option{WithClock(rp.Now)}, opts...)
	var mm tea.Model = New(rp, opts...)
	mm, _ = mm.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m := mm.(*Model)
	for range n {
		e, ok := rp.Next()
		if !ok {
			t.Fatal("fixture ended early")
		}
		nm, cmd := m.Update(eventMsg(e))
		m = settle(t, nm.(*Model), cmd)
	}
	return m
}

func TestReplayGoldens(t *testing.T) {
	rp := fixtureReplay(t)
	if len(rp.events) != 40 || rp.Skipped() != 0 {
		t.Fatalf("fixture has %d events, %d skipped", len(rp.events), rp.Skipped())
	}
	// All six running, then the stall and the first queue entry, then both merges.
	for _, tc := range []struct {
		name string
		n    int
	}{{"running", 24}, {"stalled", 33}, {"merged", 40}} {
		t.Run(tc.name, func(t *testing.T) {
			rp := fixtureReplay(t)
			m := replayModel(t, rp, tc.n)
			goldenCheck(t, "testdata/replay_"+tc.name+"_100x30.golden", view(m))
		})
	}
}

func TestReplayFixtureShape(t *testing.T) {
	rp := fixtureReplay(t)
	m := replayModel(t, rp, 40)
	if m.merged != 2 {
		t.Fatalf("merged = %d, want 2", m.merged)
	}
	if got := len(m.board.Slots); got != 4 {
		t.Fatalf("slots = %d, want 4", got)
	}
	stalled := 0
	for _, s := range m.board.Slots {
		if s.Phase == api.PhaseStalled {
			stalled++
		}
	}
	if stalled != 1 {
		t.Fatalf("stalled = %d, want 1", stalled)
	}
}

func TestOperatorOnlyShowsTokens(t *testing.T) {
	for _, op := range []bool{false, true} {
		m := replayModel(t, fixtureReplay(t), 24, WithOperator(op))
		got := view(m)
		has := strings.Contains(got, "tokens") || strings.Contains(got, "█") || strings.Contains(got, "%")
		if has != op {
			t.Fatalf("operator=%v, view shows tokens=%v\n%s", op, has, got)
		}
	}
}

func TestReplaySkipsMalformedLines(t *testing.T) {
	src := `{"v":1,"time":"2026-01-02T12:00:00Z","kind":"dispatched","ticket":"1","data":{"title":"A"}}
not json
{"v":1,"kind":"dispatched"}
{"v":1,"time":"2026-01-02T12:00:05Z","kind":"pushed","ticket":"1"}
`
	rp := loadReplay(t, src)
	if rp.Skipped() != 2 || len(rp.events) != 2 {
		t.Fatalf("skipped %d, events %d", rp.Skipped(), len(rp.events))
	}
	m := replayModel(t, rp, 2)
	if got := view(m); !strings.Contains(got, "skipped 2 malformed lines") || !strings.Contains(got, "#1 A") {
		t.Fatalf("view:\n%s", got)
	}
}

func TestReplayPlaysAtSpeed(t *testing.T) {
	rp := fixtureReplay(t)
	rp.speed = 10
	var slept time.Duration
	rp.sleep = func(d time.Duration) { slept += d }
	ch, err := rp.Events(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for range ch {
		n++
	}
	span := rp.events[len(rp.events)-1].Time.Sub(rp.events[0].Time)
	if n != 40 || slept != span/10 {
		t.Fatalf("events %d, slept %v, want 40 and %v", n, slept, span/10)
	}
}

func TestReplayWritesRefuse(t *testing.T) {
	rp := fixtureReplay(t)
	if err := rp.Cancel(context.Background(), "101"); err == nil {
		t.Fatal("cancel on a replay must fail")
	}
}
