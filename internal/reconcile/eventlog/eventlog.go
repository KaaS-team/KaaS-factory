// Package eventlog keeps an append-only log of the steps the scheduler completed for each ticket.
// Every line carries a checksum of the ticket's state after that step, so a restart can replay the
// log, trust it, and resume without repeating a step (Symphony 14.3). The idea is Temporal's
// mutable-state checksum and rebuilder; no code is copied.
package eventlog

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Kind names one logged step.
type Kind string

// The steps the log records.
const (
	KindDispatch Kind = "dispatch" // a session was started for Attempt
	KindSteer    Kind = "steer"    // the session was told to push
	KindRetry    Kind = "retry"    // the attempt was given up and queued to run again at At
	KindEnd      Kind = "end"      // the ticket left the scheduler (done, canceled or needs a human)
	KindAudit    Kind = "audit"    // the log was repaired on replay; the state is unchanged
)

// Event is one logged step. Ticket is set on the steps that can start an entry (dispatch, retry).
type Event struct {
	Seq     int          `json:"seq"`
	Time    time.Time    `json:"time"`
	Kind    Kind         `json:"kind"`
	Ticket  *api.Ticket  `json:"ticket,omitempty"`
	Attempt int          `json:"attempt,omitempty"`
	Session *api.Session `json:"session,omitempty"`
	At      time.Time    `json:"at,omitzero"`
	Reason  string       `json:"reason,omitempty"`
	Sum     string       `json:"sum"` // checksum of the entry after this event
}

// Entry is the folded state of one live ticket.
type Entry struct {
	Ticket    api.Ticket
	Phase     api.Phase
	Attempt   int
	Session   *api.Session
	StartedAt time.Time
	SteeredAt time.Time
	RetryAt   time.Time
	Error     string
}

// fold applies ev to e and returns the new state; nil means the ticket holds nothing.
func fold(e *Entry, ev Event) *Entry {
	var n Entry
	if e != nil {
		n = *e
	}
	switch ev.Kind {
	case KindDispatch:
		if ev.Ticket != nil {
			n.Ticket = *ev.Ticket
		}
		n.Phase, n.Attempt, n.Session, n.StartedAt = api.PhaseRunning, ev.Attempt, ev.Session, ev.Time
		n.SteeredAt, n.RetryAt, n.Error = time.Time{}, time.Time{}, ""
	case KindRetry:
		if ev.Ticket != nil {
			n.Ticket = *ev.Ticket
		}
		if ev.Attempt > 0 {
			n.Attempt = ev.Attempt
		}
		n.Phase, n.Session, n.SteeredAt, n.RetryAt, n.Error = api.PhaseRetryQueue, nil, time.Time{}, ev.At, ev.Reason
	case KindSteer:
		if e == nil {
			return nil
		}
		n.Phase, n.SteeredAt = api.PhaseStalled, ev.Time
	case KindEnd:
		return nil
	default: // audit and unknown kinds leave the state alone
		return e
	}
	return &n
}

// checksum is the hex SHA-256 of the entry's JSON; a nil entry has its own fixed sum.
func checksum(e *Entry) string {
	b, _ := json.Marshal(e)
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

type tlog struct {
	seq   int
	state *Entry
}

// Store is a directory of per-ticket logs, one `<ticket>.jsonl` file each.
type Store struct {
	dir string
	mu  sync.Mutex
	t   map[api.TicketID]*tlog
}

// Open returns a Store on dir, creating it when missing.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return nil, err
	}
	return &Store{dir: dir, t: map[api.TicketID]*tlog{}}, nil
}

func (s *Store) path(id api.TicketID) string {
	return filepath.Join(s.dir, url.PathEscape(string(id))+".jsonl")
}

// Append adds one step to the ticket's log, writes it through to disk and returns once synced. The
// event's Seq and Sum are set here.
func (s *Store) Append(id api.TicketID, ev Event) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.appendLocked(id, ev)
}

func (s *Store) appendLocked(id api.TicketID, ev Event) error {
	l, _, err := s.load(id)
	if err != nil {
		return err
	}
	ev.Seq, ev.Sum = l.seq+1, ""
	// Round-trip so the folded state is exactly what a replay will see.
	b, err := json.Marshal(ev)
	if err != nil {
		return err
	}
	if err := json.Unmarshal(b, &ev); err != nil {
		return err
	}
	next := fold(l.state, ev)
	ev.Sum = checksum(next)
	if b, err = json.Marshal(ev); err != nil {
		return err
	}
	f, err := os.OpenFile(s.path(id), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	_, werr := f.Write(append(b, '\n'))
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr != nil {
		return werr
	}
	l.seq, l.state = ev.Seq, next
	return nil
}

// load returns the cached log for id, replaying the file the first time. The string is an audit
// message when the file had to be repaired.
func (s *Store) load(id api.TicketID) (*tlog, string, error) {
	if l, ok := s.t[id]; ok {
		return l, "", nil
	}
	l := &tlog{}
	p := s.path(id)
	data, err := os.ReadFile(p)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, "", err
	}
	good, problem := 0, ""
	for rest := data; len(rest) > 0 && problem == ""; {
		i := bytes.IndexByte(rest, '\n')
		if i < 0 {
			problem = "torn last line"
			break
		}
		var ev Event
		switch {
		case json.Unmarshal(rest[:i], &ev) != nil:
			problem = "unreadable line"
		case ev.Seq != l.seq+1:
			problem = fmt.Sprintf("sequence %d after %d", ev.Seq, l.seq)
		default:
			next := fold(l.state, ev)
			if checksum(next) != ev.Sum {
				problem = "checksum mismatch"
				break
			}
			l.seq, l.state = ev.Seq, next
			good += i + 1
			rest = rest[i+1:]
		}
	}
	var audit string
	if problem != "" {
		audit = fmt.Sprintf("event log for %s: %s after step %d; rebuilt from the log up to there", id, problem, l.seq)
		if err := os.WriteFile(p+".bad", data[good:], 0o600); err != nil {
			return nil, "", err
		}
		if err := os.Truncate(p, int64(good)); err != nil {
			return nil, "", err
		}
	}
	s.t[id] = l
	if problem != "" {
		if err := s.appendLocked(id, Event{Kind: KindAudit, Time: time.Now(), Reason: audit}); err != nil {
			return nil, "", err
		}
	}
	return l, audit, nil
}

// Replay reads every ticket's log and returns the live tickets with their state. Audits lists one
// message for each log that was repaired; each repair is also written to that log as an audit step.
func (s *Store) Replay() (map[api.TicketID]Entry, []string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	names, err := filepath.Glob(filepath.Join(s.dir, "*.jsonl"))
	if err != nil {
		return nil, nil, err
	}
	out := map[api.TicketID]Entry{}
	var audits []string
	for _, n := range names {
		raw, err := url.PathUnescape(strings.TrimSuffix(filepath.Base(n), ".jsonl"))
		if err != nil {
			continue
		}
		l, audit, err := s.load(api.TicketID(raw))
		if err != nil {
			return nil, nil, err
		}
		if audit != "" {
			audits = append(audits, audit)
		}
		if l.state != nil {
			out[api.TicketID(raw)] = *l.state
		}
	}
	return out, audits, nil
}
