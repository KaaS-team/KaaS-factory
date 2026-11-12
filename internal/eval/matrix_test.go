package eval

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// tryDeps passes ticket "a" on try 2 and never passes "b". It counts dispatches.
type tryDeps struct {
	calls    map[api.TicketID]int
	failOn   api.TicketID // Dispatch returns an error for this ticket, as a killed run would
	flipPass bool         // re-scoring answer for every ticket
}

func (d *tryDeps) Dispatch(ctx context.Context, t api.Ticket) (Outcome, error) {
	if t.ID == d.failOn {
		return Outcome{}, errors.New("killed")
	}
	d.calls[t.ID]++
	if info, ok := ctx.Value(runKey{}).(runInfo); ok && info.save != nil {
		info.save([]Message{{Role: "user", Content: "x"}})
	}
	return Outcome{Attempts: 1, Malformed: 1, Output: "patch-" + string(t.ID), Updates: []api.Usage{{InputTokens: 10, OutputTokens: 1, CostUSD: 0.5}}, Wall: time.Second}, nil
}
func (d *tryDeps) Gate(context.Context, api.Ticket) (bool, error) { return true, nil }
func (d *tryDeps) HiddenTest(_ context.Context, t api.Ticket, _ string) (bool, error) {
	if d.flipPass {
		return true, nil
	}
	return t.ID == "a" && d.calls["a"] >= 2, nil
}

func abMatrix() Matrix {
	return Matrix{Fixtures: []Fixture{{Name: "f", Hidden: "true", Tickets: []FixtureTicket{{Ticket: api.Ticket{ID: "a"}}, {Ticket: api.Ticket{ID: "b"}}}}}}
}

// Ticket 2(a): the cell has pass_rate_1..N, cost and malformed_count, flat in the JSON.
func TestCellPassRatesCostMalformed(t *testing.T) {
	d := &tryDeps{calls: map[api.TicketID]int{}}
	sc, err := RunArm(context.Background(), abMatrix(), d, Arm{Arm: "preset", Agent: "claude", Format: "diff", Tries: 3})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(sc.Cells)
	var got []map[string]any
	if err := json.Unmarshal(raw, &got); err != nil || len(got) != 1 {
		t.Fatalf("cells %s", raw)
	}
	c := got[0]
	want := map[string]any{"pass_rate_1": 0.0, "pass_rate_2": 0.5, "pass_rate_3": 0.5, "malformed_count": 5.0, "cost_usd": 2.5, "format": "diff", "agent": "claude", "arm": "preset", "fixture": "f"}
	for k, v := range want {
		if c[k] != v {
			t.Errorf("%s = %v want %v (%s)", k, c[k], v, raw)
		}
	}
	var back []Cell
	if err := json.Unmarshal(raw, &back); err != nil || len(back[0].PassRates) != 3 || back[0].PassRates[1] != 0.5 {
		t.Fatalf("round trip: %v %+v", err, back)
	}
}

func TestCellUnmarshalRejectsBadKey(t *testing.T) {
	var c Cell
	if err := json.Unmarshal([]byte(`{"pass_rate_x":1}`), &c); err == nil {
		t.Fatal("want error")
	}
}

// Ticket 2: killing a run mid-way and restarting reruns only the unfinished tickets.
func TestResumeRerunsOnlyUnfinished(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenRunStore(dir)
	d := &tryDeps{calls: map[api.TicketID]int{}, failOn: "b"}
	if _, err := RunArm(context.Background(), abMatrix(), d, Arm{Store: st}); err == nil {
		t.Fatal("want the kill error")
	}
	stale := filepath.Join(dir, "%2F%2F%2Ff%2Fb", "stale.txt")
	if err := os.MkdirAll(filepath.Dir(stale), 0o755); err != nil || os.WriteFile(stale, []byte("x"), 0o644) != nil {
		t.Fatal("setup")
	}
	if es, _ := filepath.Glob(filepath.Join(dir, "results-*.tmp")); len(es) != 0 {
		t.Fatalf("temp file left: %v", es)
	}
	st2, err := OpenRunStore(dir)
	if err != nil {
		t.Fatal(err)
	}
	d2 := &tryDeps{calls: map[api.TicketID]int{}}
	sc, err := RunArm(context.Background(), abMatrix(), d2, Arm{Store: st2})
	if err != nil {
		t.Fatal(err)
	}
	if d2.calls["a"] != 0 || d2.calls["b"] != 1 || len(sc.Tickets) != 2 {
		t.Fatalf("calls %v tickets %d", d2.calls, len(sc.Tickets))
	}
	if _, err := os.Stat(stale); err == nil {
		t.Fatal("stale file of the unfinished ticket survived the rerun")
	}
	if _, err := os.Stat(filepath.Join(dir, "%2F%2F%2Ff%2Fa", "trajectory.json")); err != nil {
		t.Fatalf("trajectory of a finished ticket missing: %v", err)
	}
	d3 := &tryDeps{calls: map[api.TicketID]int{}}
	st3, _ := OpenRunStore(dir)
	if _, err := RunArm(context.Background(), abMatrix(), d3, Arm{Store: st3, Redo: true}); err != nil || d3.calls["a"] != 1 {
		t.Fatalf("redo did not rerun: %v %v", err, d3.calls)
	}
}

func TestOpenRunStoreRejectsForeignFile(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "results.json"), []byte(`{"schema":"other"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := OpenRunStore(dir); err == nil {
		t.Fatal("want error")
	}
}

// Ticket 2(c): replay re-scores stored outputs and never dispatches.
func TestReplayRescoresWithoutDispatch(t *testing.T) {
	dir := t.TempDir()
	st, _ := OpenRunStore(dir)
	first := &tryDeps{calls: map[api.TicketID]int{}}
	if _, err := RunArm(context.Background(), abMatrix(), first, Arm{Store: st}); err != nil {
		t.Fatal(err)
	}
	if first.calls["a"] != 1 {
		t.Fatal("setup")
	}
	st2, _ := OpenRunStore(dir)
	re := &tryDeps{calls: map[api.TicketID]int{}, failOn: "a", flipPass: true}
	sc, err := RunArm(context.Background(), abMatrix(), re, Arm{Store: st2, Replay: true})
	if err != nil {
		t.Fatalf("replay dispatched: %v", err)
	}
	if len(re.calls) != 0 || sc.Aggregate.PassRate != 1 || sc.Tickets[0].Malformed != 1 {
		t.Fatalf("calls %v pass %v", re.calls, sc.Aggregate.PassRate)
	}
	empty, _ := OpenRunStore(t.TempDir())
	if _, err := RunArm(context.Background(), abMatrix(), re, Arm{Store: empty, Replay: true}); err == nil || !strings.Contains(err.Error(), "no stored output") {
		t.Fatalf("want no stored output, got %v", err)
	}
	if _, err := RunArm(context.Background(), abMatrix(), re, Arm{Replay: true}); err == nil {
		t.Fatal("replay without a store must fail")
	}
}
