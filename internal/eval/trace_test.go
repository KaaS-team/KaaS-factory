package eval

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/trace"
)

// gateDeps fails the base gate for ticket "2" and the hidden test for ticket "3".
type gateDeps struct{ solver }

func (gateDeps) Gate(_ context.Context, t api.Ticket) (bool, error) { return t.ID != "2", nil }
func (gateDeps) HiddenTest(_ context.Context, t api.Ticket, _ string) (bool, error) {
	return t.ID != "3", nil
}

type memSink struct{ spans []trace.Span }

func (*memSink) OnTraceStart(trace.Trace) {}
func (*memSink) OnTraceEnd(trace.Trace)   {}
func (*memSink) OnSpanStart(trace.Span)   {}
func (m *memSink) OnSpanEnd(s trace.Span) { m.spans = append(m.spans, s) }

// Acceptance: gate spans carry a triggered flag.
func TestRunGateSpansCarryTriggered(t *testing.T) {
	m := &memSink{}
	if _, err := Run(context.Background(), matrix4(), gateDeps{}, WithSink(m)); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"f/1 base-green": false, "f/2 base-green": true, "f/3 hidden": true, "f/1 hidden": false}
	got := map[string]bool{}
	for _, s := range m.spans {
		if s.Type == trace.SpanGate {
			if s.Triggered == nil {
				t.Fatalf("gate span %s has no flag", s.Name)
			}
			got[s.TraceID+" "+s.Name] = *s.Triggered
		}
	}
	for k, v := range want {
		if g, ok := got[k]; !ok || g != v {
			t.Errorf("%s: got %v (present %v), want %v", k, g, ok, v)
		}
	}
}

// Acceptance: one task run writes a trace file, and eval replay reads it.
func TestEvalRunWritesTraceAndReplayReadsIt(t *testing.T) {
	dir := t.TempDir()
	out, run := newTestCommand(t, dir, map[api.TicketID]bool{"1": true})
	if err := run("--workflow", "default", "--agent", "claude", "--fixtures", fixturesDir, "--out", dir); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "2026-11-12-default-claude.trace.jsonl")
	lines, err := trace.ReadFile(path)
	if err != nil || len(lines) == 0 {
		t.Fatalf("trace file: %d lines, err %v", len(lines), err)
	}
	out.Reset()
	if err := run("replay", path); err != nil {
		t.Fatal(err)
	}
	if s := out.String(); !strings.Contains(s, "triggered") || !strings.Contains(s, "gate") {
		t.Fatalf("replay output lacks gate lines:\n%s", s)
	}
}

func TestReplayRejectsBadFile(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "bad.jsonl")
	if err := os.WriteFile(bad, []byte("{\"event\":\"bogus\"}\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, run := newTestCommand(t, t.TempDir(), nil)
	if err := run("replay", bad); err == nil {
		t.Fatal("want error")
	}
	if err := run("replay", filepath.Join(t.TempDir(), "none")); err == nil {
		t.Fatal("want error for missing file")
	}
	var b bytes.Buffer
	if err := Replay(&b, nil); err != nil || b.Len() != 0 {
		t.Fatalf("empty replay: %v %q", err, b.String())
	}
}

// Replay is exported, so a hand-built gate line with no Triggered flag must be an error, not a panic.
func TestReplayRejectsGateSpanWithoutTriggered(t *testing.T) {
	line := trace.Line{Event: trace.EventSpanEnd, Span: &trace.Span{TraceID: "t", Type: trace.SpanGate, Name: "g"}}
	if err := Replay(&bytes.Buffer{}, []trace.Line{line}); err == nil {
		t.Fatal("want an error for a nil Triggered")
	}
	if err := Replay(&bytes.Buffer{}, []trace.Line{{Event: trace.EventSpanEnd}}); err == nil {
		t.Fatal("want an error for a missing span")
	}
}
