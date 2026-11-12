package stall

import (
	"bufio"
	"os"
	"testing"
)

const window, threshold = 8, 3

func feedFile(t *testing.T, name string, upTo int) *Log {
	t.Helper()
	f, err := os.Open("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.Close() })
	l := &Log{}
	sc := bufio.NewScanner(f)
	for n := 0; sc.Scan() && (upTo == 0 || n < upTo); n++ {
		l.Feed(sc.Bytes())
	}
	return l
}

// Fixture: real stream-json shape, same failing command repeated.
func TestLoopingSessionFlagsAtThreshold(t *testing.T) {
	// Each call is two lines (call, result); the third repeat is line 5.
	if feedFile(t, "looping.ndjson", 3).Stalled(window, threshold) {
		t.Fatal("flagged before threshold repeats")
	}
	if !feedFile(t, "looping.ndjson", 5).Stalled(window, threshold) {
		t.Fatal("not flagged after threshold repeats")
	}
}

func TestCleanSessionIsNotStalled(t *testing.T) {
	for n := 0; n <= 12; n++ {
		if feedFile(t, "clean.ndjson", n).Stalled(window, threshold) {
			t.Fatalf("false positive after %d lines", n)
		}
	}
}

func call(id, name, in string) Message {
	return Message{Role: "assistant", Content: []byte(`[{"type":"tool_use","id":"` + id + `","name":"` + name + `","input":` + in + `}]`)}
}

func result(id string, isErr bool) Message {
	e := "false"
	if isErr {
		e = "true"
	}
	return Message{Role: "user", Content: []byte(`[{"type":"tool_result","tool_use_id":"` + id + `","is_error":` + e + `}]`)}
}

func chat(name, args string) Message {
	return Message{Role: "assistant", ToolCalls: []ToolCall{{Function: Function{Name: name, Arguments: []byte(args)}}}}
}

func TestDetect(t *testing.T) {
	tests := []struct {
		name      string
		msgs      []Message
		window    int
		threshold int
		want      bool
	}{
		{"nil messages", nil, 8, 3, false},
		{"zero threshold", []Message{call("1", "A", "{}")}, 8, 0, false},
		{"fewer calls than threshold", []Message{call("1", "A", "{}"), call("2", "A", "{}")}, 8, 3, false},
		{"newest repeats threshold times", []Message{call("1", "A", `{"x":1,"y":2}`), call("2", "A", `{"y":2,"x":1}`), call("3", "A", `{"x":1,"y":2}`)}, 8, 3, true},
		{"repeat broken by lookup still stuck", []Message{call("1", "A", "{}"), call("2", "B", "{}"), call("3", "A", "{}"), call("4", "A", "{}")}, 8, 3, true},
		{"recovered: old repeats then new call", []Message{call("1", "A", "{}"), call("2", "A", "{}"), call("3", "A", "{}"), call("4", "B", "{}")}, 8, 3, false},
		{"repeats outside window", []Message{call("1", "A", "{}"), call("2", "A", "{}"), call("3", "B", "{}"), call("4", "C", "{}"), call("5", "A", "{}")}, 3, 3, false},
		{"errors across different calls", []Message{call("1", "A", "{}"), result("1", true), call("2", "B", "{}"), result("2", true), call("3", "C", "{}"), result("3", true)}, 8, 3, true},
		{"newest not errored, old errors", []Message{call("1", "A", "{}"), result("1", true), call("2", "B", "{}"), result("2", true), call("3", "C", "{}"), result("3", true), call("4", "D", "{}"), result("4", false)}, 8, 3, false},
		{"errors below threshold", []Message{call("1", "A", "{}"), result("1", true), call("2", "B", "{}"), result("2", true), call("3", "C", "{}"), result("3", true)}, 8, 4, false},
		{"chat shape repeats, args as string vs object", []Message{chat("A", `"{\"x\":1,\"y\":2}"`), chat("A", `{"y":2,"x":1}`), chat("A", `{"x":1,"y":2}`)}, 8, 3, true},
		{"chat shape never errors", []Message{chat("A", `"not json"`), chat("B", `"not json"`), chat("C", `"not json"`)}, 8, 3, false},
		{"unparseable string args compare as text", []Message{chat("A", `"{bad"`), chat("A", `"{bad"`), chat("A", `"{bad"`)}, 8, 3, true},
		{"string content ignored", []Message{{Role: "assistant", Content: []byte(`"hi"`)}, call("1", "A", "{}")}, 8, 1, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Detect(tc.msgs, tc.window, tc.threshold); got != tc.want {
				t.Fatalf("Detect = %v, want %v", got, tc.want)
			}
		})
	}
}
