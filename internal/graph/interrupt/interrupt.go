// Ported from langchain-ai/langgraph@a054ed0 libs/langgraph/langgraph/types.py (Interrupt, interrupt)

// Package interrupt parks a node on a question for a person and resumes it with their answer.
//
// It follows langgraph's interrupt semantics: a node that needs an answer calls Interrupt, which
// returns a *Pending error carrying the payload, an optional response schema and an id that is the
// same on every replay. The runner stores that, stops the node, and later calls Resume. The node
// then runs again from its top; the n-th Interrupt call returns the n-th stored answer, so several
// interrupts in one task are matched by order. Everything is in SQLite, so a restart keeps a
// pending question and an answer nobody has consumed yet.
package interrupt

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/google/jsonschema-go/jsonschema"
)

const schema = `
CREATE TABLE IF NOT EXISTS interrupts (
  thread TEXT NOT NULL, idx INTEGER NOT NULL, id TEXT NOT NULL,
  payload TEXT NOT NULL, schema TEXT NOT NULL, response TEXT,
  PRIMARY KEY (thread, idx));
CREATE TABLE IF NOT EXISTS effects (
  thread TEXT NOT NULL, key TEXT NOT NULL, PRIMARY KEY (thread, key));
`

// ErrNothingPending is returned by Resume when the thread has no unanswered interrupt.
var ErrNothingPending = errors.New("interrupt: nothing is waiting on this thread")

// Interrupt is a question parked for a person. ID is stable across replays of the same task.
type Interrupt struct {
	ID      string          `json:"id"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Schema  json.RawMessage `json:"schema,omitempty"` // JSON Schema the answer must satisfy; empty accepts any JSON
}

// Pending is the error a node returns while an Interrupt has no answer yet.
type Pending struct{ Interrupt }

// Error says which interrupt is waiting.
func (p *Pending) Error() string { return "interrupt: waiting for an answer to " + p.ID }

// Book stores interrupts and answers in SQLite.
type Book struct{ db *sql.DB }

// Open creates the tables on db and returns a Book over it.
func Open(db *sql.DB) (*Book, error) {
	if _, err := db.Exec(schema); err != nil {
		return nil, fmt.Errorf("interrupt schema: %w", err)
	}
	return &Book{db: db}, nil
}

// Task is one run of a node. Its Interrupt calls are numbered from zero in call order.
type Task struct {
	b      *Book
	thread string
	next   int
}

// Task starts a run of the node that owns thread. Make a new Task for every replay.
func (b *Book) Task(thread string) *Task { return &Task{b: b, thread: thread} }

func idFor(thread string, idx int) string {
	h := sha256.Sum256(fmt.Appendf(nil, "%s\x00%d", thread, idx))
	return hex.EncodeToString(h[:8])
}

// Interrupt returns the stored answer for this call, or stores the question and returns a *Pending.
// payload and schema are JSON; a nil schema accepts any answer.
func (t *Task) Interrupt(ctx context.Context, payload, schema json.RawMessage) (json.RawMessage, error) {
	idx := t.next
	t.next++
	var resp sql.NullString
	err := t.b.db.QueryRowContext(ctx, `SELECT response FROM interrupts WHERE thread=? AND idx=?`, t.thread, idx).Scan(&resp)
	switch {
	case err == nil && resp.Valid:
		return json.RawMessage(resp.String), nil
	case err == nil:
	case errors.Is(err, sql.ErrNoRows):
		if _, err := t.b.db.ExecContext(ctx, `INSERT INTO interrupts (thread, idx, id, payload, schema) VALUES (?,?,?,?,?)`,
			t.thread, idx, idFor(t.thread, idx), string(payload), string(schema)); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	return nil, &Pending{Interrupt{ID: idFor(t.thread, idx), Payload: payload, Schema: schema}}
}

// Once runs fn the first time key is seen on this thread and skips it on every replay after fn
// succeeded. fn gets the thread-scoped key to use as an idempotency key with the outside world:
// a crash between fn finishing and the mark being written runs fn again once.
func (t *Task) Once(ctx context.Context, key string, fn func(idempotencyKey string) error) error {
	var one int
	err := t.b.db.QueryRowContext(ctx, `SELECT 1 FROM effects WHERE thread=? AND key=?`, t.thread, key).Scan(&one)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err := fn(t.thread + "/" + key); err != nil {
		return err
	}
	_, err = t.b.db.ExecContext(ctx, `INSERT OR IGNORE INTO effects (thread, key) VALUES (?,?)`, t.thread, key)
	return err
}

// Pending lists the unanswered interrupts of thread in call order.
func (b *Book) Pending(ctx context.Context, thread string) ([]Interrupt, error) {
	rows, err := b.db.QueryContext(ctx, `SELECT id, payload, schema FROM interrupts WHERE thread=? AND response IS NULL ORDER BY idx`, thread)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var out []Interrupt
	for rows.Next() {
		var i Interrupt
		var p, s string
		if err := rows.Scan(&i.ID, &p, &s); err != nil {
			return nil, err
		}
		i.Payload, i.Schema = raw(p), raw(s)
		out = append(out, i)
	}
	return out, rows.Err()
}

func raw(s string) json.RawMessage {
	if s == "" {
		return nil
	}
	return json.RawMessage(s)
}

// Resume answers the oldest unanswered interrupt of thread. The value must be JSON and satisfy the
// interrupt's schema; a rejected value leaves the interrupt pending.
func (b *Book) Resume(ctx context.Context, thread string, value json.RawMessage) error {
	var idx int
	var sc string
	err := b.db.QueryRowContext(ctx, `SELECT idx, schema FROM interrupts WHERE thread=? AND response IS NULL ORDER BY idx LIMIT 1`, thread).Scan(&idx, &sc)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNothingPending
	}
	if err != nil {
		return err
	}
	if err := validate(sc, value); err != nil {
		return err
	}
	_, err = b.db.ExecContext(ctx, `UPDATE interrupts SET response=? WHERE thread=? AND idx=?`, string(value), thread, idx)
	return err
}

func validate(schemaJSON string, value json.RawMessage) error {
	var v any
	if err := json.Unmarshal(value, &v); err != nil {
		return fmt.Errorf("interrupt: resume value is not JSON: %w", err)
	}
	if schemaJSON == "" {
		return nil
	}
	var s jsonschema.Schema
	if err := json.Unmarshal([]byte(schemaJSON), &s); err != nil {
		return fmt.Errorf("interrupt: bad response schema: %w", err)
	}
	r, err := s.Resolve(nil)
	if err != nil {
		return fmt.Errorf("interrupt: bad response schema: %w", err)
	}
	if err := r.Validate(v); err != nil {
		return fmt.Errorf("interrupt: resume value rejected: %w", err)
	}
	return nil
}

// Done forgets the thread's interrupts and recorded effects once its node has finished.
func (b *Book) Done(ctx context.Context, thread string) error {
	for _, q := range []string{`DELETE FROM interrupts WHERE thread=?`, `DELETE FROM effects WHERE thread=?`} {
		if _, err := b.db.ExecContext(ctx, q, thread); err != nil {
			return err
		}
	}
	return nil
}
