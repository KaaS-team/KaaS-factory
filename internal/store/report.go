package store

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// reportSchema holds what `factory report` needs beyond sessions and spend. Team and pack are read
// from ticket labels, so they follow PutTicket; times and human touches come from the ticket thread.
const reportSchema = `
CREATE TABLE IF NOT EXISTS ticket_meta (
  ticket TEXT PRIMARY KEY, team TEXT NOT NULL, pack TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_times (
  ticket TEXT PRIMARY KEY, first_dispatch INTEGER NOT NULL, merged_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_touches (
  ticket TEXT PRIMARY KEY, chatops INTEGER NOT NULL, pushes INTEGER NOT NULL);
`

// Thread is what a ticket's tracker thread says about its run: when work began and merged, and how
// often a human stepped in. Zero times mean it has not happened.
type Thread struct {
	FirstDispatch   time.Time
	MergedAt        time.Time
	ChatopsCommands int // `/factory` commands from humans
	ManualPushes    int // pushes by a human to the ticket branch
}

func (th Thread) empty() bool {
	return th.FirstDispatch.IsZero() && th.MergedAt.IsZero() && th.ChatopsCommands == 0 && th.ManualPushes == 0
}

// Threader is implemented by trackers that can read a ticket's thread. Rebuild uses it, when
// present, to restore merge times and human-touch counts.
type Threader interface {
	Thread(ctx context.Context, id api.TicketID) (Thread, error)
}

// labelValue returns the value of the first label shaped "<key>:<value>", or "".
func labelValue(labels []string, key string) string {
	for _, l := range labels {
		if v, ok := strings.CutPrefix(l, key+":"); ok {
			return v
		}
	}
	return ""
}

func (s *Store) putMeta(ctx context.Context, t api.Ticket) error {
	_, err := s.db.ExecContext(ctx, `
INSERT INTO ticket_meta (ticket, team, pack) VALUES (?, ?, ?)
ON CONFLICT (ticket) DO UPDATE SET team=excluded.team, pack=excluded.pack`,
		string(t.ID), labelValue(t.Labels, "team"), labelValue(t.Labels, "pack"))
	return err
}

// RecordThread stores a ticket's dispatch and merge times and its human-touch counts, replacing
// any earlier values, so a rebuild that reads the same thread gives the same rows.
func (s *Store) RecordThread(ctx context.Context, id api.TicketID, th Thread) (err error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	if _, err = tx.ExecContext(ctx, `
INSERT INTO ticket_times (ticket, first_dispatch, merged_at) VALUES (?, ?, ?)
ON CONFLICT (ticket) DO UPDATE SET first_dispatch=excluded.first_dispatch, merged_at=excluded.merged_at`,
		string(id), nanos(th.FirstDispatch), nanos(th.MergedAt)); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `
INSERT INTO ticket_touches (ticket, chatops, pushes) VALUES (?, ?, ?)
ON CONFLICT (ticket) DO UPDATE SET chatops=excluded.chatops, pushes=excluded.pushes`,
		string(id), th.ChatopsCommands, th.ManualPushes); err != nil {
		return err
	}
	return tx.Commit()
}

func fromNanos(n int64) time.Time {
	if n == 0 {
		return time.Time{}
	}
	return time.Unix(0, n).UTC()
}

// AttemptRow is the spend one attempt on a ticket recorded.
type AttemptRow struct {
	N     int
	Usage api.Usage
}

// TicketRow is a ticket as the report reads it: labels-derived team and pack, thread data and spend.
type TicketRow struct {
	ID              api.TicketID
	Team            string
	Workflow        string
	Pack            string
	Attempts        []AttemptRow
	FirstDispatch   time.Time
	MergedAt        time.Time
	ChatopsCommands int
	ManualPushes    int
}

// ReportRows returns one TicketRow per ticket, ordered by ticket id, with its attempts
// ordered by attempt number. Spend rows are the store's own; the caller decides what to do about
// tickets with none.
func (s *Store) ReportRows(ctx context.Context) ([]TicketRow, error) {
	rows, err := s.db.QueryContext(ctx, `
SELECT t.id, t.workflow, COALESCE(m.team, ''), COALESCE(m.pack, ''),
  COALESCE(x.first_dispatch, 0), COALESCE(x.merged_at, 0), COALESCE(h.chatops, 0), COALESCE(h.pushes, 0)
FROM tickets t
LEFT JOIN ticket_meta m ON m.ticket = t.id
LEFT JOIN ticket_times x ON x.ticket = t.id
LEFT JOIN ticket_touches h ON h.ticket = t.id
ORDER BY t.id`)
	if err != nil {
		return nil, err
	}
	var out []TicketRow
	idx := map[api.TicketID]int{}
	for rows.Next() {
		var r TicketRow
		var id string
		var first, merged int64
		if err := rows.Scan(&id, &r.Workflow, &r.Team, &r.Pack, &first, &merged, &r.ChatopsCommands, &r.ManualPushes); err != nil {
			_ = rows.Close()
			return nil, err
		}
		r.ID = api.TicketID(id)
		r.FirstDispatch, r.MergedAt = fromNanos(first), fromNanos(merged)
		idx[r.ID] = len(out)
		out = append(out, r)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	sp, err := s.db.QueryContext(ctx, `
SELECT ticket, attempt, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, wall_ns
FROM spend ORDER BY ticket, attempt`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = sp.Close() }()
	for sp.Next() {
		var id string
		var a AttemptRow
		var wall int64
		u := &a.Usage
		if err := sp.Scan(&id, &a.N, &u.InputTokens, &u.OutputTokens, &u.CacheReadTokens, &u.CacheWriteTokens, &u.CostUSD, &wall); err != nil {
			return nil, err
		}
		u.WallTime = time.Duration(wall)
		i, ok := idx[api.TicketID(id)]
		if !ok {
			return nil, fmt.Errorf("spend row for unknown ticket %q", id)
		}
		out[i].Attempts = append(out[i].Attempts, a)
	}
	return out, sp.Err()
}
