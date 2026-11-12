package trace

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

func flag(b bool) *bool { return &b }

func TestJSONLSinkRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	s := NewJSONLSink(&buf)
	tr := Trace{ID: "t1", Name: "fx/1", Start: time.Unix(1, 0).UTC()}
	sp := Span{ID: "s1", TraceID: "t1", Type: SpanGate, Name: "base-green", Triggered: flag(false)}
	s.OnTraceStart(tr)
	s.OnSpanStart(sp)
	s.OnSpanEnd(sp)
	s.OnTraceEnd(tr)
	if n := strings.Count(buf.String(), "\n"); n != 4 {
		t.Fatalf("want 4 lines, got %d:\n%s", n, buf.String())
	}
	lines, err := Read(&buf)
	if err != nil {
		t.Fatal(err)
	}
	if len(lines) != 4 || lines[0].Event != EventTraceStart || lines[2].Event != EventSpanEnd || lines[3].Event != EventTraceEnd {
		t.Fatalf("events: %+v", lines)
	}
	got := lines[2].Span
	if got == nil || got.Triggered == nil || *got.Triggered {
		t.Fatalf("a gate span that did not trip must still carry triggered=false: %+v", got)
	}
}

func TestReadRejects(t *testing.T) {
	for name, in := range map[string]string{
		"not json":     "nope\n",
		"unknown":      `{"event":"bogus"}` + "\n",
		"span missing": `{"event":"span_end"}` + "\n",
		"bad type":     `{"event":"span_end","span":{"type":"voice"}}` + "\n",
		"gate no flag": `{"event":"span_end","span":{"type":"gate"}}` + "\n",
	} {
		if _, err := Read(strings.NewReader(in)); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestFileSinkAndConcurrentWrites(t *testing.T) {
	path := filepath.Join(t.TempDir(), "run.trace.jsonl")
	s, err := NewFileSink(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	for i := range 20 {
		wg.Go(func() { s.OnSpanEnd(Span{ID: string(rune('a' + i)), Type: SpanAgent, Name: "x"}) })
	}
	wg.Wait()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	lines, err := ReadFile(path)
	if err != nil || len(lines) != 20 {
		t.Fatalf("got %d lines, err %v", len(lines), err)
	}
}

func TestFileSinkClosesWithContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	path := filepath.Join(t.TempDir(), "x.jsonl")
	s, err := NewFileSink(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	<-s.Done()
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
}

// Traces can hold prompts and tool output, so the file is private to its owner.
func TestFileSinkCreatesPrivateFile(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.jsonl")
	ctx, cancel := context.WithCancel(context.Background())
	s, err := NewFileSink(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	<-s.Done()
	fi, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if got := fi.Mode().Perm(); got != 0o600 {
		t.Fatalf("trace file mode = %o, want 600", got)
	}
}
