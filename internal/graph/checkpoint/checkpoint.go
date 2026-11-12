// Ported from langchain-ai/langgraph@a054ed0 libs/checkpoint-sqlite/langgraph/checkpoint/sqlite/__init__.py

// Package checkpoint keeps a workflow run's state in SQLite, one checkpoint per step and the writes
// of tasks that finished after it, so a restart re-runs only the tasks that had not finished. The
// tables and their keys are langgraph's; state and values are JSON, so the type column holds "json".
package checkpoint

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"

	_ "modernc.org/sqlite" // pure Go driver, registers "sqlite"
)

const schema = `
CREATE TABLE IF NOT EXISTS checkpoints (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  parent_checkpoint_id TEXT,
  type TEXT,
  checkpoint BLOB,
  metadata BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id));
CREATE TABLE IF NOT EXISTS writes (
  thread_id TEXT NOT NULL,
  checkpoint_ns TEXT NOT NULL DEFAULT '',
  checkpoint_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  task_path TEXT NOT NULL DEFAULT '',
  idx INTEGER NOT NULL,
  channel TEXT NOT NULL,
  type TEXT,
  value BLOB,
  PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx));`

// Write is one output of a task that finished after a checkpoint was taken.
type Write struct {
	Task    string // the task that produced it, a node id
	Idx     int
	Channel string
	Value   []byte // JSON
}

// Checkpoint is the saved state of a thread at one step and the writes made since.
type Checkpoint struct {
	ID, ParentID string
	State        []byte
	Metadata     []byte
	Writes       []Write // ordered by task, then idx
}

// Store is the checkpoint database. Open one per file.
type Store struct{ db *sql.DB }

// Open opens or creates the database at path.
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
		return nil, fmt.Errorf("create checkpoint schema: %w", err)
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error { return s.db.Close() }

// Put saves a new checkpoint for thread after its latest one and returns its id. Ids sort in the
// order they were made.
func (s *Store) Put(ctx context.Context, thread string, state, metadata []byte) (string, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer func() { _ = tx.Rollback() }()
	var parent sql.NullString
	err = tx.QueryRowContext(ctx, `SELECT MAX(checkpoint_id) FROM checkpoints WHERE thread_id = ? AND checkpoint_ns = ''`, thread).Scan(&parent)
	if err != nil {
		return "", err
	}
	n := 0
	if parent.Valid {
		if _, err := fmt.Sscanf(parent.String, "%d", &n); err != nil {
			return "", fmt.Errorf("checkpoint id %q: %w", parent.String, err)
		}
	}
	id := fmt.Sprintf("%08d", n+1)
	if _, err := tx.ExecContext(ctx, `INSERT INTO checkpoints (thread_id, checkpoint_id, parent_checkpoint_id, type, checkpoint, metadata) VALUES (?, ?, ?, 'json', ?, ?)`,
		thread, id, parent, state, metadata); err != nil {
		return "", err
	}
	return id, tx.Commit()
}

// PutWrites records a finished task's output against a checkpoint. A repeat of the same task and
// index replaces the earlier row.
func (s *Store) PutWrites(ctx context.Context, thread, checkpointID string, w Write) error {
	_, err := s.db.ExecContext(ctx, `INSERT OR REPLACE INTO writes (thread_id, checkpoint_id, task_id, idx, channel, type, value) VALUES (?, ?, ?, ?, ?, 'json', ?)`,
		thread, checkpointID, w.Task, w.Idx, w.Channel, w.Value)
	return err
}

// Latest returns the newest checkpoint of thread with its pending writes; ok is false when the
// thread has none.
func (s *Store) Latest(ctx context.Context, thread string) (c Checkpoint, ok bool, err error) {
	var parent sql.NullString
	err = s.db.QueryRowContext(ctx, `SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints
WHERE thread_id = ? AND checkpoint_ns = '' ORDER BY checkpoint_id DESC LIMIT 1`, thread).Scan(&c.ID, &parent, &c.State, &c.Metadata)
	if errors.Is(err, sql.ErrNoRows) {
		return c, false, nil
	}
	if err != nil {
		return c, false, err
	}
	c.ParentID = parent.String
	rows, err := s.db.QueryContext(ctx, `SELECT task_id, idx, channel, value FROM writes
WHERE thread_id = ? AND checkpoint_ns = '' AND checkpoint_id = ? ORDER BY task_id, idx`, thread, c.ID)
	if err != nil {
		return c, false, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var w Write
		if err := rows.Scan(&w.Task, &w.Idx, &w.Channel, &w.Value); err != nil {
			return c, false, err
		}
		c.Writes = append(c.Writes, w)
	}
	return c, true, rows.Err()
}
