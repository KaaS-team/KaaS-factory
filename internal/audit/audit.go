// Package audit records every side effect the factory takes as one record: who or what did which
// action, to what, when, and with what result. The shape follows the OpenTelemetry log data model
// (Timestamp, SeverityText, Body, Attributes). Records go to .factory/audit/YYYY-MM-DD.jsonl and,
// when OTEL_EXPORTER_OTLP_ENDPOINT is set, to that OTLP/HTTP endpoint. Secrets are redacted first.
package audit

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/logs"
)

// Entry is one audit line.
type Entry struct {
	Timestamp    time.Time         `json:"Timestamp"`
	SeverityText string            `json:"SeverityText"`
	Body         string            `json:"Body"`
	Attributes   map[string]string `json:"Attributes"`
}

// Attribute keys every record carries.
const (
	KeyActor  = "actor"
	KeyAction = "action"
	KeyTarget = "target"
	KeyResult = "result"
	KeyTicket = "ticket"
)

// Sink is where a record goes after redaction.
type Sink interface {
	Write(ctx context.Context, r Entry) error
}

var (
	mu   sync.RWMutex
	sink Sink
	now  = time.Now
)

// SetSink installs the process-wide sink and returns a function that restores the old one.
// A nil sink turns recording off.
func SetSink(s Sink) (restore func()) {
	mu.Lock()
	old := sink
	sink = s
	mu.Unlock()
	return func() { mu.Lock(); sink = old; mu.Unlock() }
}

// actor is who is acting: FACTORY_ACTOR, or "factory".
func actor() string {
	if a := os.Getenv("FACTORY_ACTOR"); a != "" {
		return a
	}
	return "factory"
}

// Done records one action. Call it as `defer audit.Done(ctx, action, target, ticket, &err)` in a
// method with a named error result, so the result is the one the caller sees.
func Done(ctx context.Context, action, target, ticket string, errp *error) {
	var err error
	if errp != nil {
		err = *errp
	}
	Record(ctx, action, target, ticket, err)
}

// Record writes one record. A failed write never fails the action it describes: it is reported on stderr.
func Record(ctx context.Context, action, target, ticket string, err error) {
	mu.RLock()
	s := sink
	mu.RUnlock()
	if s == nil {
		return
	}
	r := Entry{
		Timestamp: now().UTC(), SeverityText: "INFO", Body: action + " " + target + ": ok",
		Attributes: map[string]string{KeyActor: actor(), KeyAction: action, KeyTarget: target, KeyResult: "ok", KeyTicket: ticket},
	}
	if err != nil {
		r.SeverityText, r.Attributes[KeyResult] = "ERROR", "error"
		r.Body = action + " " + target + ": error: " + err.Error()
	}
	r.Body = logs.Redact(r.Body)
	for k, v := range r.Attributes {
		r.Attributes[k] = logs.Redact(v)
	}
	if werr := s.Write(ctx, r); werr != nil {
		fmt.Fprintln(os.Stderr, "audit: write failed:", werr)
	}
}

// File appends JSON Lines to Dir/YYYY-MM-DD.jsonl, one file per UTC day.
type File struct {
	Dir string
	mu  sync.Mutex
}

// Write appends r to its day's file.
func (f *File) Write(_ context.Context, r Entry) error {
	line, err := json.Marshal(r)
	if err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if err := os.MkdirAll(f.Dir, 0o750); err != nil {
		return err
	}
	p := filepath.Join(f.Dir, r.Timestamp.UTC().Format("2006-01-02")+".jsonl")
	h, err := os.OpenFile(filepath.Clean(p), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	if _, err := h.Write(append(line, '\n')); err != nil {
		_ = h.Close()
		return err
	}
	return h.Close()
}

// Multi writes to every sink and returns the first error.
type Multi []Sink

// Write sends r to each sink.
func (m Multi) Write(ctx context.Context, r Entry) error {
	var first error
	for _, s := range m {
		if err := s.Write(ctx, r); err != nil && first == nil {
			first = err
		}
	}
	return first
}
