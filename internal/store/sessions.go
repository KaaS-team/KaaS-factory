package store

import (
	"context"
	"database/sql"
	"errors"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// sessionSchema holds the dispatch record `factory logs` reads. It is not the observer's
// sessions table: that one is keyed by session key and rebuilt from the work branch, while this
// one records which dispatcher and session id ran an attempt, which no branch can tell.
const sessionSchema = `
CREATE TABLE IF NOT EXISTS dispatched_sessions (
  ticket TEXT NOT NULL, attempt INTEGER NOT NULL, dispatcher TEXT NOT NULL,
  session_id TEXT NOT NULL, key TEXT NOT NULL, url TEXT NOT NULL, started_at INTEGER NOT NULL,
  PRIMARY KEY (ticket, attempt));
`

// ErrSessionNotRecorded is returned by LatestSession when the store holds no session for the
// ticket. A rebuilt store has none, so the message tells the operator why.
var ErrSessionNotRecorded = errors.New("session was not recorded for this ticket (a rebuilt store forgets sessions until the ticket is dispatched again)")

// PutSession records the session that ran an attempt, replacing an earlier record of the same attempt.
func (s *Store) PutSession(ctx context.Context, x api.Session) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO dispatched_sessions (ticket, attempt, dispatcher, session_id, key, url, started_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (ticket, attempt) DO UPDATE SET dispatcher=excluded.dispatcher,
  session_id=excluded.session_id, key=excluded.key, url=excluded.url, started_at=excluded.started_at`,
		string(x.Ticket), x.Attempt, x.Dispatcher, x.ID, x.Key, x.URL, nanos(x.StartedAt))
	return err
}

// LatestSession returns the session of the ticket's highest recorded attempt, or
// ErrSessionNotRecorded.
func (s *Store) LatestSession(ctx context.Context, id api.TicketID) (api.Session, error) {
	var x api.Session
	var started int64
	err := s.db.QueryRowContext(ctx, `
SELECT ticket, attempt, dispatcher, session_id, key, url, started_at FROM dispatched_sessions
WHERE ticket = ? ORDER BY attempt DESC LIMIT 1`, string(id)).
		Scan(&x.Ticket, &x.Attempt, &x.Dispatcher, &x.ID, &x.Key, &x.URL, &started)
	if errors.Is(err, sql.ErrNoRows) {
		return api.Session{}, ErrSessionNotRecorded
	}
	if err != nil {
		return api.Session{}, err
	}
	if started != 0 {
		x.StartedAt = time.Unix(0, started).UTC()
	}
	return x, nil
}
