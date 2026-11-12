package crypt

import (
	"context"
	"database/sql"
	"errors"
	"net/url"
	"sync"

	_ "modernc.org/sqlite" // pure Go driver, registers "sqlite"
)

// Memory is a Store held in memory.
type Memory struct {
	mu   sync.Mutex
	seq  int64
	rows map[[2]string]Row
}

// NewMemory returns an empty in-memory Store.
func NewMemory() *Memory { return &Memory{rows: map[[2]string]Row{}} }

// Put inserts or replaces the row at (Thread, ID).
func (m *Memory) Put(_ context.Context, r Row) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.seq++
	r.Seq = m.seq
	r.Data = append([]byte(nil), r.Data...)
	m.rows[[2]string{r.Thread, r.ID}] = r
	return nil
}

// Get returns the row at (thread, id).
func (m *Memory) Get(_ context.Context, thread, id string) (Row, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.rows[[2]string{thread, id}]
	return r, ok, nil
}

// Latest returns the highest-Seq row in thread.
func (m *Memory) Latest(_ context.Context, thread string) (Row, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	var best Row
	found := false
	for _, r := range m.rows {
		if r.Thread == thread && (!found || r.Seq > best.Seq) {
			best, found = r, true
		}
	}
	return best, found, nil
}

// PruneKeepLatest deletes all but the highest-Seq row in each thread.
func (m *Memory) PruneKeepLatest(_ context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	top := map[string]int64{}
	for _, r := range m.rows {
		top[r.Thread] = max(top[r.Thread], r.Seq)
	}
	n := 0
	for k, r := range m.rows {
		if r.Seq != top[r.Thread] {
			delete(m.rows, k)
			n++
		}
	}
	return n, nil
}

// SQLite is a Store in a SQLite table named checkpoints (primary key thread, id).
type SQLite struct{ db *sql.DB }

const sqliteSchema = `CREATE TABLE IF NOT EXISTS checkpoints (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, thread TEXT NOT NULL, id TEXT NOT NULL,
  type TEXT NOT NULL, data BLOB NOT NULL, UNIQUE (thread, id))`

// OpenSQLite opens or creates the database at path (":memory:" works) and ensures the table exists.
func OpenSQLite(path string) (*SQLite, error) {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	db, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(sqliteSchema); err != nil {
		_ = db.Close()
		return nil, err
	}
	return &SQLite{db: db}, nil
}

// Close closes the database.
func (s *SQLite) Close() error { return s.db.Close() }

// Put inserts or replaces the row at (Thread, ID); a replaced row takes a new Seq.
func (s *SQLite) Put(ctx context.Context, r Row) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT OR REPLACE INTO checkpoints (thread, id, type, data) VALUES (?, ?, ?, ?)`,
		r.Thread, r.ID, r.Type, r.Data)
	return err
}

func scan(row *sql.Row) (Row, bool, error) {
	var r Row
	err := row.Scan(&r.Seq, &r.Thread, &r.ID, &r.Type, &r.Data)
	if errors.Is(err, sql.ErrNoRows) {
		return Row{}, false, nil
	}
	return r, err == nil, err
}

// Get returns the row at (thread, id).
func (s *SQLite) Get(ctx context.Context, thread, id string) (Row, bool, error) {
	return scan(s.db.QueryRowContext(ctx,
		`SELECT seq, thread, id, type, data FROM checkpoints WHERE thread = ? AND id = ?`, thread, id))
}

// Latest returns the highest-Seq row in thread.
func (s *SQLite) Latest(ctx context.Context, thread string) (Row, bool, error) {
	return scan(s.db.QueryRowContext(ctx,
		`SELECT seq, thread, id, type, data FROM checkpoints WHERE thread = ? ORDER BY seq DESC LIMIT 1`, thread))
}

// PruneKeepLatest deletes all but the highest-Seq row in each thread.
func (s *SQLite) PruneKeepLatest(ctx context.Context) (int, error) {
	res, err := s.db.ExecContext(ctx,
		`DELETE FROM checkpoints WHERE seq NOT IN (SELECT MAX(seq) FROM checkpoints GROUP BY thread)`)
	if err != nil {
		return 0, err
	}
	n, err := res.RowsAffected()
	return int(n), err
}
