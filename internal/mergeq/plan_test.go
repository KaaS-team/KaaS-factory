package mergeq

import (
	"reflect"
	"testing"
)

func open(head string) PRState { return PRState{Head: head, Open: true} }

func res(ids, heads []string, base string, pass bool) Result {
	return Result{IDs: ids, Heads: heads, Base: base, Ref: "ref-" + Key(ids, heads), Pass: pass, Log: "log-" + Key(ids, heads)}
}

func withResults(st State, rs ...Result) State {
	st.Results = map[string]Result{}
	for _, r := range rs {
		st.Results[Key(r.IDs, r.Heads)] = r
	}
	return st
}

func q(n int) []Entry {
	var out []Entry
	for i := 1; i <= n; i++ {
		out = append(out, Entry{ID: string(rune('0' + i)), Head: "h" + string(rune('0'+i))})
	}
	return out
}

func prs(n int) map[string]PRState {
	m := map[string]PRState{}
	for _, e := range q(n) {
		m[e.ID] = open(e.Head)
	}
	return m
}

func ids(a ...string) []string { return a }

// Every row is one branch of Plan. The batch rows follow Symphony section 7's rule that state is
// re-derived from observation each pass.
func TestPlan(t *testing.T) {
	base := State{Base: "B", BatchSize: 4, PRs: prs(8)}
	r12 := res(ids("1", "2"), ids("h1", "h2"), "B", true)
	tests := []struct {
		name  string
		queue []Entry
		st    State
		want  []Action
	}{
		{"empty queue", nil, base, nil},
		{"one PR untested", q(1), base, []Action{{Kind: KindTest, IDs: ids("1"), Heads: ids("h1")}}},
		{"one PR green lands", q(1), withResults(base, res(ids("1"), ids("h1"), "B", true)),
			[]Action{{Kind: KindLand, IDs: ids("1"), Heads: ids("h1"), Ref: "ref-1@h1"}}},
		{"batch of 4 untested is one test", q(4), base,
			[]Action{{Kind: KindTest, IDs: ids("1", "2", "3", "4"), Heads: ids("h1", "h2", "h3", "h4")}}},
		{"batch of 4 green is one fast-forward", q(4),
			withResults(base, res(ids("1", "2", "3", "4"), ids("h1", "h2", "h3", "h4"), "B", true)),
			[]Action{{Kind: KindLand, IDs: ids("1", "2", "3", "4"), Heads: ids("h1", "h2", "h3", "h4"), Ref: "ref-1@h1,2@h2,3@h3,4@h4"}}},
		{"queue longer than batch tests only the first batch", q(6), base,
			[]Action{{Kind: KindTest, IDs: ids("1", "2", "3", "4"), Heads: ids("h1", "h2", "h3", "h4")}}},
		{"batch size defaults to 4", q(6), State{Base: "B", PRs: prs(6)},
			[]Action{{Kind: KindTest, IDs: ids("1", "2", "3", "4"), Heads: ids("h1", "h2", "h3", "h4")}}},
		{"green on an older base is tested again", q(1), withResults(base, res(ids("1"), ids("h1"), "OLD", true)),
			[]Action{{Kind: KindTest, IDs: ids("1"), Heads: ids("h1")}}},
		{"red batch: test the first half", q(4),
			withResults(base, res(ids("1", "2", "3", "4"), ids("h1", "h2", "h3", "h4"), "B", false)),
			[]Action{{Kind: KindTest, IDs: ids("1", "2"), Heads: ids("h1", "h2")}}},
		{"red batch, first half green: land it", q(4),
			withResults(base, res(ids("1", "2", "3", "4"), ids("h1", "h2", "h3", "h4"), "B", false), r12),
			[]Action{{Kind: KindLand, IDs: ids("1", "2"), Heads: ids("h1", "h2"), Ref: "ref-1@h1,2@h2"}}},
		{"red batch, first half green on old base: test it again", q(4),
			withResults(base, res(ids("1", "2", "3", "4"), ids("h1", "h2", "h3", "h4"), "B", false),
				res(ids("1", "2"), ids("h1", "h2"), "OLD", true)),
			[]Action{{Kind: KindTest, IDs: ids("1", "2"), Heads: ids("h1", "h2")}}},
		{"red batch, first half red: descend", q(4),
			withResults(base, res(ids("1", "2", "3", "4"), ids("h1", "h2", "h3", "h4"), "B", false),
				res(ids("1", "2"), ids("h1", "h2"), "B", false)),
			[]Action{{Kind: KindTest, IDs: ids("1"), Heads: ids("h1")}}},
		{"culprit alone red: eject with the log tail", q(2),
			withResults(base, res(ids("1", "2"), ids("h1", "h2"), "B", false), res(ids("1"), ids("h1"), "B", false)),
			[]Action{{Kind: KindEject, ID: "1", Log: "log-1@h1"}}},
		{"inferred red leftover pair splits", q(2),
			withResults(base, Result{IDs: ids("1", "2"), Heads: ids("h1", "h2"), Inferred: true}),
			[]Action{{Kind: KindTest, IDs: ids("1"), Heads: ids("h1")}}},
		{"inferred red alone is tested before ejection", q(1),
			withResults(base, Result{IDs: ids("1"), Heads: ids("h1"), Inferred: true}),
			[]Action{{Kind: KindTest, IDs: ids("1"), Heads: ids("h1")}}},
		{"head moved after queueing is requeued", []Entry{{ID: "1", Head: "old"}},
			State{Base: "B", PRs: map[string]PRState{"1": open("new")}},
			[]Action{{Kind: KindRequeue, ID: "1", Head: "new"}}},
		{"old green result is never used for a moved head", []Entry{{ID: "1", Head: "new"}},
			withResults(State{Base: "B", PRs: map[string]PRState{"1": open("new")}}, res(ids("1"), ids("old"), "B", true)),
			[]Action{{Kind: KindTest, IDs: ids("1"), Heads: ids("new")}}},
		{"PR closed while queued is dropped", q(1), State{Base: "B", PRs: map[string]PRState{"1": {Head: "h1"}}},
			[]Action{{Kind: KindDrop, ID: "1", Reason: ReasonClosed}}},
		{"PR missing from state counts as closed", q(1), State{Base: "B"},
			[]Action{{Kind: KindDrop, ID: "1", Reason: ReasonClosed}}},
		{"PR already merged is dropped, not merged again", q(1), State{Base: "B", PRs: map[string]PRState{"1": {Head: "h1", Open: true, Merged: true}}},
			[]Action{{Kind: KindDrop, ID: "1", Reason: ReasonMerged}}},
		{"housekeeping comes before testing the rest", append(q(1), Entry{ID: "x", Head: "hx"}),
			State{Base: "B", PRs: map[string]PRState{"1": open("h1")}},
			[]Action{{Kind: KindDrop, ID: "x", Reason: ReasonClosed}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := Plan(tc.queue, tc.st)
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got  %+v\nwant %+v", got, tc.want)
			}
		})
	}
}

func TestAfterLandInfersRedRemainder(t *testing.T) {
	red := res(ids("1", "2", "3", "4"), ids("h1", "h2", "h3", "h4"), "B", false)
	in := map[string]Result{Key(red.IDs, red.Heads): red}
	out := AfterLand(in, ids("1", "2"), ids("h1", "h2"))
	got, ok := out[Key(ids("3", "4"), ids("h3", "h4"))]
	if !ok || got.Pass || !got.Inferred || got.Log != red.Log {
		t.Fatalf("want inferred red for 3,4, got %+v ok=%v", got, ok)
	}
	if len(in) != 1 {
		t.Fatal("input map was modified")
	}
	// A green set, a different prefix, and a set no longer than the landed one infer nothing.
	green := res(ids("1", "2", "3"), ids("h1", "h2", "h3"), "B", true)
	other := res(ids("5", "6"), ids("h5", "h6"), "B", false)
	same := res(ids("1", "2"), ids("h1", "h2"), "B", false)
	moved := res(ids("1", "2", "3"), ids("h1", "hX", "h3"), "B", false)
	out = AfterLand(map[string]Result{"g": green, "o": other, "s": same, "m": moved}, ids("1", "2"), ids("h1", "h2"))
	if len(out) != 4 {
		t.Fatalf("want no inferred results, got %d entries", len(out))
	}
}
