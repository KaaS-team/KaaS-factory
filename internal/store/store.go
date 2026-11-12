// Package store is a SQLite cache of what the factory knows about its tickets.
//
// It holds no truth of its own. Tickets come from the tracker and everything else from the observer,
// so Rebuild can fill an empty file with the same rows the live one held (Symphony §14: restart
// from the tracker plus the filesystem).
package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"

	_ "modernc.org/sqlite" // pure Go driver, registers "sqlite"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/observe"
)

// MaxAttempts bounds how many attempts Rebuild probes per ticket.
const MaxAttempts = 20

const schema = `
CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY, repo TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
  labels TEXT NOT NULL, files TEXT NOT NULL, blocked_by TEXT NOT NULL,
  priority INTEGER NOT NULL, workflow TEXT NOT NULL, created_at INTEGER NOT NULL,
  phase TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  key TEXT PRIMARY KEY, ticket TEXT NOT NULL, attempt INTEGER NOT NULL,
  branch TEXT NOT NULL, last_push INTEGER NOT NULL, has_report INTEGER NOT NULL,
  pr INTEGER NOT NULL, checks_green TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  ticket TEXT NOT NULL, attempt INTEGER NOT NULL, kind TEXT NOT NULL,
  time INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (ticket, attempt, kind));
CREATE TABLE IF NOT EXISTS spend (
  ticket TEXT NOT NULL, attempt INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL, cache_write_tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL, wall_ns INTEGER NOT NULL, PRIMARY KEY (ticket, attempt));
` + reportSchema + sessionSchema

// Store is the cache. Open one per database file.
type Store struct{ db *sql.DB }

// Lister is implemented by trackers that can list tickets beyond the ready ones.
type Lister interface {
	Active(ctx context.Context) ([]api.Ticket, error)
}

// Open opens or creates the database at path and ensures the tables exist.
func Open(path string) (*Store, error) {
	q := url.Values{}
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "busy_timeout(5000)")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

func jsonOf(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		return "null"
	}
	return string(b)
}

// PutTicket inserts or updates a ticket. A new ticket starts in the ready phase; an existing
// ticket keeps its phase.
func (s *Store) PutTicket(ctx context.Context, t api.Ticket) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO tickets (id, repo, title, body, labels, files, blocked_by, priority, workflow, created_at, phase)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (id) DO UPDATE SET repo=excluded.repo, title=excluded.title, body=excluded.body,
  labels=excluded.labels, files=excluded.files, blocked_by=excluded.blocked_by,
  priority=excluded.priority, workflow=excluded.workflow, created_at=excluded.created_at`,
		string(t.ID), t.Repo, t.Title, t.Body, jsonOf(nonNil(t.Labels)), jsonOf(nonNil(t.Files)),
		jsonOf(nonNil(t.BlockedBy)), t.Priority, t.Workflow, t.CreatedAt.UnixNano(), string(api.PhaseReady))
	if err != nil {
		return err
	}
	return s.putMeta(ctx, t)
}

func nonNil[T any](s []T) []T {
	if s == nil {
		return []T{}
	}
	return s
}

// Phase returns the stored phase of a ticket.
func (s *Store) Phase(ctx context.Context, id api.TicketID) (api.Phase, error) {
	var p string
	err := s.db.QueryRowContext(ctx, `SELECT phase FROM tickets WHERE id = ?`, string(id)).Scan(&p)
	return api.Phase(p), err
}

// Apply records one observation: the session row, its spend, an "observed" event, and the ticket's
// phase when this is the newest attempt seen for it. It is the only writer of those tables, so a
// rebuild that replays observations gives the rows the live store holds.
func (s *Store) Apply(ctx context.Context, o api.Observation) (err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	id := string(o.Ticket)
	if _, err = tx.ExecContext(ctx, `UPDATE tickets SET phase = ? WHERE id = ?
AND NOT EXISTS (SELECT 1 FROM sessions WHERE ticket = ? AND attempt > ?)`,
		string(observe.PhaseOf(o)), id, id, o.Attempt); err != nil {
		return err
	}
	green := "none"
	if o.ChecksGreen != nil {
		green = fmt.Sprint(*o.ChecksGreen)
	}
	report := 0
	if o.HasReport {
		report = 1
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO sessions (key, ticket, attempt, branch, last_push, has_report, pr, checks_green)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (key) DO UPDATE SET branch=excluded.branch, last_push=excluded.last_push,
  has_report=excluded.has_report, pr=excluded.pr, checks_green=excluded.checks_green`,
		fmt.Sprintf("%s-a%d", id, o.Attempt), id, o.Attempt, o.Branch, nanos(o.LastPush), report, o.PR, green); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO events (ticket, attempt, kind, time, data) VALUES (?, ?, 'observed', ?, ?)
ON CONFLICT (ticket, attempt, kind) DO UPDATE SET time=excluded.time, data=excluded.data`,
		id, o.Attempt, nanos(o.LastPush), jsonOf(map[string]any{"phase": observe.PhaseOf(o), "pr": o.PR, "report": o.HasReport, "files": nonNil(o.DiffFiles)})); err != nil {
		return err
	}
	u := o.Usage
	if _, err = tx.ExecContext(ctx, `
INSERT INTO spend (ticket, attempt, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, wall_ns)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (ticket, attempt) DO UPDATE SET input_tokens=excluded.input_tokens,
  output_tokens=excluded.output_tokens, cache_read_tokens=excluded.cache_read_tokens,
  cache_write_tokens=excluded.cache_write_tokens, cost_usd=excluded.cost_usd, wall_ns=excluded.wall_ns`,
		id, o.Attempt, u.InputTokens, u.OutputTokens, u.CacheReadTokens, u.CacheWriteTokens, u.CostUSD, int64(u.WallTime)); err != nil {
		return err
	}
	return tx.Commit()
}

func nanos(t time.Time) int64 {
	if t.IsZero() {
		return 0
	}
	return t.UnixNano()
}

// Rebuild fills the store from the tracker and observer alone. Tickets come from the tracker:
// its ready tickets plus, when it has one, its Active list (claimed and unfinished work), so a
// restart keeps both the queue and the work in flight. Each ticket's attempts are probed upward
// from 1 until the observer reports no work branch for that attempt.
func (s *Store) Rebuild(ctx context.Context, tr api.Tracker, ob api.Observer) error {
	tickets, err := tr.Ready(ctx)
	if err != nil {
		return fmt.Errorf("list ready tickets: %w", err)
	}
	if l, ok := tr.(Lister); ok {
		active, err := l.Active(ctx)
		if err != nil {
			return fmt.Errorf("list active tickets: %w", err)
		}
		seen := make(map[api.TicketID]bool, len(tickets))
		for _, t := range tickets {
			seen[t.ID] = true
		}
		for _, t := range active {
			if !seen[t.ID] {
				tickets = append(tickets, t)
			}
		}
	}
	for _, t := range tickets {
		if err := s.PutTicket(ctx, t); err != nil {
			return err
		}
		for a := 1; a <= MaxAttempts; a++ {
			o, err := ob.Observe(ctx, t.ID, a)
			if err != nil {
				return fmt.Errorf("observe %s attempt %d: %w", t.ID, a, err)
			}
			if o.Branch == "" || o.Attempt != a {
				break
			}
			if err := s.Apply(ctx, o); err != nil {
				return err
			}
		}
		if th, ok := tr.(Threader); ok {
			thread, err := th.Thread(ctx, t.ID)
			if err != nil {
				return fmt.Errorf("read thread of %s: %w", t.ID, err)
			}
			if thread.empty() {
				continue // nothing happened yet: no row, as in the live store
			}
			if err := s.RecordThread(ctx, t.ID, thread); err != nil {
				return err
			}
		}
	}
	return nil
}

// Dump returns every row of every table as one sorted line each, for comparing two stores.
func (s *Store) Dump(ctx context.Context) ([]string, error) {
	var out []string
	for _, tb := range []struct{ name, order string }{
		{"tickets", "id"}, {"sessions", "key"}, {"events", "ticket, attempt, kind"}, {"spend", "ticket, attempt"},
		{"ticket_meta", "ticket"}, {"ticket_times", "ticket"}, {"ticket_touches", "ticket"},
	} {
		rows, err := s.db.QueryContext(ctx, "SELECT * FROM "+tb.name+" ORDER BY "+tb.order)
		if err != nil {
			return nil, err
		}
		cols, err := rows.Columns()
		if err != nil {
			_ = rows.Close()
			return nil, err
		}
		for rows.Next() {
			vals := make([]any, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			if err := rows.Scan(ptrs...); err != nil {
				_ = rows.Close()
				return nil, err
			}
			parts := make([]string, len(cols))
			for i, c := range cols {
				parts[i] = fmt.Sprintf("%s=%v", c, vals[i])
			}
			out = append(out, tb.name+": "+strings.Join(parts, " "))
		}
		if err := errors.Join(rows.Err(), rows.Close()); err != nil {
			return nil, err
		}
	}
	return out, nil
}
