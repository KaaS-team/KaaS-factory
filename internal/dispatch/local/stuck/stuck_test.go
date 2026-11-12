package stuck

import (
	"encoding/json"
	"fmt"
	"testing"
)

func j(v any) []byte { b, _ := json.Marshal(v); return b }

func call(resp, id, name string, input map[string]any) []byte {
	return j(map[string]any{"type": "assistant", "message": map[string]any{"id": resp, "content": []any{
		map[string]any{"type": "tool_use", "id": id, "name": name, "input": input}}}})
}

func result(id, text string, isErr bool) []byte {
	return j(map[string]any{"type": "user", "message": map[string]any{"content": []any{
		map[string]any{"type": "tool_result", "tool_use_id": id, "content": text, "is_error": isErr}}}})
}

func say(text string) []byte {
	return j(map[string]any{"type": "assistant", "message": map[string]any{"id": "m", "content": []any{map[string]any{"type": "text", "text": text}}}})
}

func user(text string) []byte {
	return j(map[string]any{"type": "user", "message": map[string]any{"content": text}})
}

func compact() []byte { return j(map[string]any{"type": "system", "subtype": "compact_boundary"}) }

// pair is one call and its result; n makes the ids unique without changing what is compared.
func pair(n int, name string, in map[string]any, out string, isErr bool) [][]byte {
	id := fmt.Sprintf("t%d", n)
	return [][]byte{call(fmt.Sprintf("r%d", n), id, name, in), result(id, out, isErr)}
}

func repeat(count int, name string, in map[string]any, out string, isErr bool) (lines [][]byte) {
	for i := 0; i < count; i++ {
		lines = append(lines, pair(i, name, in, out, isErr)...)
	}
	return lines
}

// feed returns every non-Continue verdict, in order.
func feed(g *Guard, lines [][]byte) (vs []Verdict) {
	for _, l := range lines {
		if v := g.Feed(l); v.Kind != Continue {
			vs = append(vs, v)
		}
	}
	return vs
}

func kinds(vs []Verdict) (ks []Kind) {
	for _, v := range vs {
		ks = append(ks, v.Kind)
	}
	return ks
}

func same(a, b []Kind) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestPatterns(t *testing.T) {
	ls := map[string]any{"cmd": "ls"}
	rows := []struct {
		name  string
		lines [][]byte
		want  []Kind
		pat   Pattern // pattern of the first verdict
	}{
		{"scenario 1: same call, same result, 3 times is not yet a loop", repeat(3, "Bash", ls, "a", false), nil, ""},
		{"scenario 1: same call, same result, 4 times nudges", repeat(4, "Bash", ls, "a", false), []Kind{Nudge}, ActionObservation},
		{"scenario 1: the next 4 repeats after the nudge abort", repeat(8, "Bash", ls, "a", false), []Kind{Nudge, Abort}, ActionObservation},
		{"scenario 1: key order does not matter", [][]byte{
			call("r1", "t1", "Bash", map[string]any{"a": 1, "b": 2}), result("t1", "x", false),
			call("r2", "t2", "Bash", map[string]any{"b": 2, "a": 1}), result("t2", "x", false),
			call("r3", "t3", "Bash", map[string]any{"a": 1, "b": 2}), result("t3", "x", false),
			call("r4", "t4", "Bash", map[string]any{"b": 2, "a": 1}), result("t4", "x", false),
		}, []Kind{Nudge}, ActionObservation},
		{"scenario 1: same call with a changing result is progress", func() (l [][]byte) {
			for i := 0; i < 6; i++ {
				l = append(l, pair(i, "Bash", ls, fmt.Sprint("out", i), false)...)
			}
			return l
		}(), nil, ""},
		{"scenario 1: different calls are not a loop", func() (l [][]byte) {
			for i := 0; i < 6; i++ {
				l = append(l, pair(i, "Bash", map[string]any{"cmd": fmt.Sprint("ls", i)}, "a", false)...)
			}
			return l
		}(), nil, ""},
		{"scenario 2: the third identical error nudges", repeat(3, "Bash", ls, "boom", true), []Kind{Nudge}, ActionError},
		{"scenario 2: the fourth identical error aborts", repeat(4, "Bash", ls, "boom", true), []Kind{Nudge, Abort}, ActionError},
		{"scenario 2: the streak counts the call, not the error text: nudge at 3, abort at 4", func() (l [][]byte) {
			for i := 0; i < 4; i++ {
				l = append(l, pair(i, "Bash", ls, fmt.Sprint("err", i), true)...)
			}
			return l
		}(), []Kind{Nudge, Abort}, ActionError},
		{"scenario 1: an error and a success with the same text are different results", func() (l [][]byte) {
			for i := 0; i < 4; i++ {
				l = append(l, pair(i, "Bash", ls, "x", i%2 == 0)...)
			}
			return l
		}(), nil, ""},
		{"scenario 2: an error then a success is no streak", append(repeat(2, "Bash", ls, "boom", true), pair(9, "Bash", ls, "ok", false)...), nil, ""},
		{"scenario 2: parallel calls in one response are one attempt, so 2 responses never reach the error streak", func() (l [][]byte) {
			for r := 0; r < 2; r++ {
				a, b := fmt.Sprintf("a%d", r), fmt.Sprintf("b%d", r)
				l = append(l, j(map[string]any{"type": "assistant", "message": map[string]any{"id": fmt.Sprint("r", r), "content": []any{
					map[string]any{"type": "tool_use", "id": a, "name": "Bash", "input": ls},
					map[string]any{"type": "tool_use", "id": b, "name": "Bash", "input": ls}}}}),
					result(a, fmt.Sprint("boom", r), true), result(b, fmt.Sprint("boom", r), true))
			}
			return l
		}(), nil, ""},
		{"scenario 3: two agent messages are not a monologue", [][]byte{say("a"), say("b")}, nil, ""},
		{"scenario 3: three agent messages in a row nudge", [][]byte{say("a"), say("b"), say("c")}, []Kind{Nudge}, Monologue},
		{"scenario 3: a tool result in between breaks it", [][]byte{say("a"), say("b"), result("x", "r", false), say("c")}, nil, ""},
		{"scenario 4: A B A B A B alternation nudges", func() (l [][]byte) {
			for i := 0; i < 6; i++ {
				in, out := ls, "one"
				if i%2 == 1 {
					in, out = map[string]any{"cmd": "pwd"}, "two"
				}
				l = append(l, pair(i, "Bash", in, out, false)...)
			}
			return l
		}(), []Kind{Nudge}, Alternating},
		{"scenario 5: three compactions with nothing between nudge", func() (l [][]byte) {
			for i := 0; i < 8; i++ {
				l = append(l, pair(i, "Bash", map[string]any{"cmd": fmt.Sprint(i)}, fmt.Sprint(i), false)...)
			}
			return append(l, compact(), compact(), compact())
		}(), []Kind{Nudge}, Compaction},
		// Ported behaviour: go/k9-stall internal/dispatch/stall/stall.go counted errors across different calls.
		{"error-run: three errors from three different calls nudge", func() (l [][]byte) {
			for i := 0; i < 3; i++ {
				l = append(l, pair(i, "Bash", map[string]any{"cmd": fmt.Sprint("try", i)}, fmt.Sprint("err", i), true)...)
			}
			return l
		}(), []Kind{Nudge}, ErrorRun},
		{"error-run: two errors are not yet a run", func() (l [][]byte) {
			for i := 0; i < 2; i++ {
				l = append(l, pair(i, "Bash", map[string]any{"cmd": fmt.Sprint("try", i)}, "e", true)...)
			}
			return l
		}(), nil, ""},
		{"error-run: a success after the nudge is progress, never an abort", func() (l [][]byte) {
			for i := 0; i < 3; i++ {
				l = append(l, pair(i, "Bash", map[string]any{"cmd": fmt.Sprint("try", i)}, "e", true)...)
			}
			return append(l, pair(9, "Bash", map[string]any{"cmd": "fixed"}, "ok", false)...)
		}(), []Kind{Nudge}, ErrorRun},
		{"a user message starts a fresh window", append(repeat(3, "Bash", ls, "a", false), append([][]byte{user("go on")}, repeat(3, "Bash", ls, "a", false)...)...), nil, ""},
		{"lines that are not tool or message events are ignored", [][]byte{[]byte("not json"), []byte(`{"type":"result"}`), []byte(`{"type":"system","subtype":"init"}`)}, nil, ""},
	}
	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			vs := feed(New(DefaultThresholds), r.lines)
			if !same(kinds(vs), r.want) {
				t.Fatalf("verdicts %v, want %v", vs, r.want)
			}
			if len(vs) > 0 && vs[0].Pattern != r.pat {
				t.Errorf("pattern %q, want %q", vs[0].Pattern, r.pat)
			}
			for _, v := range vs {
				if v.Message == "" {
					t.Errorf("verdict %v has no message", v)
				}
			}
		})
	}
}

func TestNudgeIsOnePerRun(t *testing.T) {
	g := New(DefaultThresholds)
	vs := feed(g, repeat(4, "Bash", map[string]any{"cmd": "ls"}, "a", false))
	if !same(kinds(vs), []Kind{Nudge}) {
		t.Fatalf("setup: %v", vs)
	}
	// A different loop after the nudge aborts instead of nudging again.
	vs = feed(g, [][]byte{say("a"), say("b"), say("c")})
	if !same(kinds(vs), []Kind{Abort}) {
		t.Fatalf("second hit: %v, want one abort", vs)
	}
}

func TestWindowIsTwentyEvents(t *testing.T) {
	// 4 identical pairs buried under newer, different ones do not count: only the last 20 events are scanned.
	g := New(DefaultThresholds)
	lines := repeat(3, "Bash", map[string]any{"cmd": "ls"}, "a", false)
	for i := 0; i < 11; i++ {
		lines = append(lines, pair(100+i, "Bash", map[string]any{"cmd": fmt.Sprint(i)}, fmt.Sprint(i), false)...)
	}
	lines = append(lines, pair(200, "Bash", map[string]any{"cmd": "ls"}, "a", false)...)
	if vs := feed(g, lines); len(vs) != 0 {
		t.Fatalf("got %v", vs)
	}
}

func TestWindowIsTwentyEventsForAlternation(t *testing.T) {
	// 12 alternating pairs need 24 events; the window holds 20, so a threshold of 12 can never be met.
	th := DefaultThresholds
	th.Alternating = 12
	var lines [][]byte
	for i := 0; i < 12; i++ {
		in, out := map[string]any{"cmd": "ls"}, "one"
		if i%2 == 1 {
			in, out = map[string]any{"cmd": "pwd"}, "two"
		}
		lines = append(lines, pair(i, "Bash", in, out, false)...)
	}
	if vs := feed(New(th), lines); len(vs) != 0 {
		t.Fatalf("got %v", vs)
	}
}

func TestNudgeResetsAfterProgress(t *testing.T) {
	g := New(DefaultThresholds)
	vs := feed(g, repeat(3, "Bash", map[string]any{"cmd": "false"}, "boom", true))
	if !same(kinds(vs), []Kind{Nudge}) {
		t.Fatalf("action-error setup: %v", vs)
	}
	// A different action is progress; the unrelated stall that follows gets its own nudge, not an abort.
	feed(g, pair(50, "Read", map[string]any{"path": "a"}, "ok", false))
	vs = feed(g, [][]byte{say("a"), say("b"), say("c")})
	if !same(kinds(vs), []Kind{Nudge}) {
		t.Fatalf("stall after progress: %v, want one nudge", vs)
	}
	// With no progress in between, the next hit still aborts.
	vs = feed(g, [][]byte{say("d"), say("e"), say("f")})
	if !same(kinds(vs), []Kind{Abort}) {
		t.Fatalf("stall without progress: %v, want one abort", vs)
	}
}
