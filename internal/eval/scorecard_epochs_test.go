package eval

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

// scriptedDeps answers HiddenTest from a per-command script: each call pops the next result.
type scriptedDeps struct {
	fakeDeps
	script map[string][]bool
	greens []bool // Gate answers in order; empty means green
	ran    []string
}

func (s *scriptedDeps) Gate(context.Context, api.Ticket) (bool, error) {
	if len(s.greens) == 0 {
		return true, nil
	}
	g := s.greens[0]
	s.greens = s.greens[1:]
	return g, nil
}

func (s *scriptedDeps) HiddenTest(_ context.Context, _ api.Ticket, cmd string) (bool, error) {
	s.ran = append(s.ran, cmd)
	r := s.script[cmd]
	s.script[cmd] = r[1:]
	return r[0], nil
}

func oneTicket(f Fixture) Matrix {
	f.Name, f.Tickets = "f", toFT([]api.Ticket{{ID: "1"}})
	return Matrix{Fixtures: []Fixture{f}}
}

// A flaky fixture passes 1 epoch of 3: mean says fail, at_least_k and pass_at_k say pass.
func TestFlakyFixtureDiffersByReducer(t *testing.T) {
	cases := []struct {
		reducer string
		k       int
		merged  int
		reduced float64
	}{
		{"mean", 0, 0, 1.0 / 3},
		{"at_least_k", 1, 1, 1},
		{"pass_at_k", 3, 1, 1},
		{"max", 0, 1, 1},
	}
	for _, tc := range cases {
		t.Run(tc.reducer, func(t *testing.T) {
			d := &scriptedDeps{script: map[string][]bool{"h": {false, true, false}}}
			m := oneTicket(Fixture{Hidden: "h", Epochs: 3, Reducer: tc.reducer, K: tc.k})
			sc, err := RunArm(context.Background(), m, d, Arm{})
			if err != nil {
				t.Fatal(err)
			}
			r := sc.Tickets[0]
			if sc.Aggregate.Merged != tc.merged || r.Reduced != tc.reduced || len(r.Epochs) != 3 {
				t.Fatalf("merged %d reduced %v epochs %d", sc.Aggregate.Merged, r.Reduced, len(r.Epochs))
			}
			if !strings.Contains(Markdown(sc, false), fmt.Sprintf("reduced score %.2f over 3 epochs", tc.reduced)) {
				t.Fatal("scorecard does not show the reduced score")
			}
		})
	}
}

func TestEpochsDefaultToOneAndRejectBadConfig(t *testing.T) {
	d := &scriptedDeps{script: map[string][]bool{"h": {true}}}
	sc, err := RunArm(context.Background(), oneTicket(Fixture{Hidden: "h"}), d, Arm{})
	if err != nil || len(sc.Tickets[0].Epochs) != 1 || sc.Aggregate.Merged != 1 {
		t.Fatalf("%+v %v", sc, err)
	}
	for _, f := range []Fixture{{Hidden: "h", Epochs: -1}, {Hidden: "h", Epochs: 2, Reducer: "median"}, {Hidden: "h", Epochs: 2, Reducer: "pass_at_k", K: 3}} {
		if _, err := RunArm(context.Background(), oneTicket(f), &scriptedDeps{}, Arm{}); err == nil {
			t.Errorf("%+v accepted", f)
		}
	}
}

// The cascade runs scorers cheap first, stops at the first pass and records which one decided.
func TestScorecardCascadeRecordsDecidedBy(t *testing.T) {
	d := &scriptedDeps{script: map[string][]bool{"cheap": {true}, "hidden": {true}}}
	sc, err := RunArm(context.Background(), oneTicket(Fixture{Hidden: "hidden", Scorers: []string{"cheap", "hidden"}}), d, Arm{})
	if err != nil {
		t.Fatal(err)
	}
	if got := sc.Tickets[0].Epochs[0].DecidedBy; got != "cheap" || len(d.ran) != 1 {
		t.Fatalf("decided_by %q ran %v", got, d.ran)
	}
	d = &scriptedDeps{script: map[string][]bool{"cheap": {false}, "hidden": {true}}}
	sc, _ = RunArm(context.Background(), oneTicket(Fixture{Hidden: "hidden", Scorers: []string{"cheap", "hidden"}}), d, Arm{})
	if got := sc.Tickets[0].Epochs[0].DecidedBy; got != "hidden" || len(d.ran) != 2 || sc.Aggregate.Merged != 1 {
		t.Fatalf("decided_by %q ran %v", got, d.ran)
	}
}

func TestMarkdownShowsWilsonInterval(t *testing.T) {
	sc, err := RunArm(context.Background(), matrix4(), fakeDeps{passIDs: map[api.TicketID]bool{"1": true, "2": true, "3": true}}, Arm{})
	if err != nil {
		t.Fatal(err)
	}
	// 3 of 4 at 95%: Wilson 0.3006 to 0.9544
	for _, customer := range []bool{false, true} {
		if md := Markdown(sc, customer); !strings.Contains(md, "95% Wilson interval 0.30 to 0.95") {
			t.Fatalf("customer=%v:\n%s", customer, md)
		}
	}
	if md := Markdown(Scorecard{}, false); strings.Contains(md, "Wilson") {
		t.Fatal("an empty scorecard has no interval")
	}
}

// Half the epochs passing is a pass for mean (the threshold is inclusive); a red base in any epoch blocks the merge.
func TestPassThresholdInclusiveAndBaseGreenAcrossEpochs(t *testing.T) {
	d := &scriptedDeps{script: map[string][]bool{"h": {true, false}}}
	sc, err := RunArm(context.Background(), oneTicket(Fixture{Hidden: "h", Epochs: 2}), d, Arm{})
	if err != nil || sc.Aggregate.Merged != 1 || sc.Tickets[0].Reduced != 0.5 {
		t.Fatalf("%+v %v", sc, err)
	}
	d = &scriptedDeps{script: map[string][]bool{"h": {true, true}}, greens: []bool{false, true}}
	sc, _ = RunArm(context.Background(), oneTicket(Fixture{Hidden: "h", Epochs: 2}), d, Arm{})
	if tr := sc.Tickets[0]; !tr.HiddenPass || tr.BaseGreen || tr.Merged {
		t.Fatalf("%+v", tr)
	}
}
