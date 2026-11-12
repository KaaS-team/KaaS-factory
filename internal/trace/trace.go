// Ported from openai/openai-agents-python@64fbde5 src/agents/tracing/span_data.py
// and src/agents/tracing/processor_interface.py (design only, MIT).

// Package trace is the span schema for eval traces and the sink that records them.
package trace

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// SpanType names what a span measured.
type SpanType string

// The five span types the factory records.
const (
	SpanAgent      SpanType = "agent"
	SpanTool       SpanType = "tool"
	SpanHandoff    SpanType = "handoff"
	SpanGate       SpanType = "gate"
	SpanGeneration SpanType = "generation"
)

// Trace is one task run, from start to end.
type Trace struct {
	ID    string    `json:"id"`
	Name  string    `json:"name"`
	Start time.Time `json:"start,omitzero"`
	End   time.Time `json:"end,omitzero"`
}

// Span is one step inside a trace. Only the fields of its Type are set. Triggered is
// required on a gate span and false means the gate let the step through.
// Generation spans carry token counts, never a model name.
type Span struct {
	ID           string    `json:"id"`
	TraceID      string    `json:"trace_id"`
	ParentID     string    `json:"parent_id,omitempty"`
	Type         SpanType  `json:"type"`
	Name         string    `json:"name,omitempty"`
	Start        time.Time `json:"start,omitzero"`
	End          time.Time `json:"end,omitzero"`
	Input        string    `json:"input,omitempty"`
	Output       string    `json:"output,omitempty"`
	From         string    `json:"from,omitempty"`
	To           string    `json:"to,omitempty"`
	Triggered    *bool     `json:"triggered,omitempty"`
	InputTokens  int64     `json:"input_tokens,omitempty"`
	OutputTokens int64     `json:"output_tokens,omitempty"`
}

// Sink receives trace and span events as they happen. Implementations must be safe for concurrent use.
type Sink interface {
	OnTraceStart(Trace)
	OnTraceEnd(Trace)
	OnSpanStart(Span)
	OnSpanEnd(Span)
}

// Event kinds written on each line of a trace file.
const (
	EventTraceStart = "trace_start"
	EventTraceEnd   = "trace_end"
	EventSpanStart  = "span_start"
	EventSpanEnd    = "span_end"
)

// Line is one JSONL record: an event and the trace or span it is about.
type Line struct {
	Event string `json:"event"`
	Trace *Trace `json:"trace,omitempty"`
	Span  *Span  `json:"span,omitempty"`
}

// JSONLSink writes one JSON line per event to a writer.
type JSONLSink struct {
	mu sync.Mutex
	w  io.Writer
}

// NewJSONLSink returns a sink that appends events to w.
func NewJSONLSink(w io.Writer) *JSONLSink { return &JSONLSink{w: w} }

func (s *JSONLSink) write(l Line) {
	b, err := json.Marshal(l)
	if err != nil { // the schema holds only strings, numbers and times
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, _ = s.w.Write(append(b, '\n')) // tracing never fails the run it observes
}

// OnTraceStart records the start of a trace.
func (s *JSONLSink) OnTraceStart(t Trace) { s.write(Line{Event: EventTraceStart, Trace: &t}) }

// OnTraceEnd records the end of a trace.
func (s *JSONLSink) OnTraceEnd(t Trace) { s.write(Line{Event: EventTraceEnd, Trace: &t}) }

// OnSpanStart records the start of a span.
func (s *JSONLSink) OnSpanStart(sp Span) { s.write(Line{Event: EventSpanStart, Span: &sp}) }

// OnSpanEnd records the end of a span.
func (s *JSONLSink) OnSpanEnd(sp Span) { s.write(Line{Event: EventSpanEnd, Span: &sp}) }

// FileSink is a JSONLSink on a file that closes when its context ends.
type FileSink struct {
	*JSONLSink
	f    *os.File
	bw   *bufio.Writer
	once sync.Once
	err  error
	done chan struct{}
}

// NewFileSink creates path (mode 0600, since traces can hold prompts and tool output) and returns a sink on it. Cancelling ctx flushes and closes the file.
func NewFileSink(ctx context.Context, path string) (*FileSink, error) {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return nil, err
	}
	bw := bufio.NewWriter(f)
	s := &FileSink{JSONLSink: NewJSONLSink(bw), f: f, bw: bw, done: make(chan struct{})}
	go func() {
		select {
		case <-ctx.Done():
			_ = s.Close()
		case <-s.done:
		}
	}()
	return s, nil
}

// Done is closed once the file is closed.
func (s *FileSink) Done() <-chan struct{} { return s.done }

// Close flushes and closes the file. It is safe to call more than once.
func (s *FileSink) Close() error {
	s.once.Do(func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.err = s.bw.Flush()
		if err := s.f.Close(); s.err == nil {
			s.err = err
		}
		close(s.done)
	})
	return s.err
}

// Read parses a trace file and rejects lines the schema does not allow.
func Read(r io.Reader) ([]Line, error) {
	var out []Line
	sc := bufio.NewScanner(r)
	sc.Buffer(nil, 1<<20)
	for n := 1; sc.Scan(); n++ {
		var l Line
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			return nil, fmt.Errorf("trace line %d: %w", n, err)
		}
		if err := l.validate(); err != nil {
			return nil, fmt.Errorf("trace line %d: %w", n, err)
		}
		out = append(out, l)
	}
	return out, sc.Err()
}

// ReadFile is Read on a file.
func ReadFile(path string) ([]Line, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return Read(f)
}

func (l Line) validate() error {
	switch l.Event {
	case EventTraceStart, EventTraceEnd:
		if l.Trace == nil {
			return fmt.Errorf("%s has no trace", l.Event)
		}
	case EventSpanStart, EventSpanEnd:
		if l.Span == nil {
			return fmt.Errorf("%s has no span", l.Event)
		}
		switch l.Span.Type {
		case SpanAgent, SpanTool, SpanHandoff, SpanGeneration:
		case SpanGate:
			if l.Span.Triggered == nil {
				return fmt.Errorf("gate span %q has no triggered flag", l.Span.Name)
			}
		default:
			return fmt.Errorf("unknown span type %q", l.Span.Type)
		}
	default:
		return fmt.Errorf("unknown event %q", l.Event)
	}
	return nil
}
