package eventlog

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func tk(id string) *api.Ticket {
	return &api.Ticket{ID: api.TicketID(id), Title: "t " + id, Labels: []string{"x"}}
}

func open(t *testing.T, dir string) *Store {
	t.Helper()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// Every event kind has a row: the fold decides phase and which fields survive.
func TestFold(t *testing.T) {
	sess := &api.Session{Key: "a-a1", ID: "s1"}
	base := &Entry{Ticket: *tk("a"), Phase: api.PhaseRunning, Attempt: 1, Session: sess, StartedAt: t0}
	tests := []struct {
		name string
		from *Entry
		ev   Event
		want *Entry
	}{
		{"dispatch", nil, Event{Kind: KindDispatch, Time: t0, Ticket: tk("a"), Attempt: 1, Session: sess},
			base},
		{"steer", base, Event{Kind: KindSteer, Time: t0.Add(time.Minute)},
			&Entry{Ticket: *tk("a"), Phase: api.PhaseStalled, Attempt: 1, Session: sess, StartedAt: t0, SteeredAt: t0.Add(time.Minute)}},
		{"retry clears session", base, Event{Kind: KindRetry, Time: t0, At: t0.Add(time.Minute), Reason: "stalled"},
			&Entry{Ticket: *tk("a"), Phase: api.PhaseRetryQueue, Attempt: 1, StartedAt: t0, RetryAt: t0.Add(time.Minute), Error: "stalled"}},
		{"retry from nil takes the ticket", nil, Event{Kind: KindRetry, Time: t0, Ticket: tk("a"), Attempt: 2, At: t0, Reason: "boom"},
			&Entry{Ticket: *tk("a"), Phase: api.PhaseRetryQueue, Attempt: 2, RetryAt: t0, Error: "boom"}},
		{"end", base, Event{Kind: KindEnd, Reason: "done"}, nil},
		{"audit changes nothing", base, Event{Kind: KindAudit, Reason: "x"}, base},
		{"steer on nothing", nil, Event{Kind: KindSteer}, nil},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := fold(tc.from, tc.ev)
			if checksum(got) != checksum(tc.want) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

// Symphony 14.3: a restart replays the log, and the replayed state carries the session.
func TestReplayAfterReopen(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	sess := &api.Session{Key: "a-a1", ID: "s1", StartedAt: t0}
	for _, ev := range []Event{
		{Kind: KindDispatch, Time: t0, Ticket: tk("a"), Attempt: 1, Session: sess},
		{Kind: KindSteer, Time: t0.Add(time.Minute)},
	} {
		if err := s.Append("a", ev); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.Append("b", Event{Kind: KindDispatch, Time: t0, Ticket: tk("b"), Attempt: 1, Session: sess}); err != nil {
		t.Fatal(err)
	}
	if err := s.Append("b", Event{Kind: KindEnd, Time: t0, Reason: "done"}); err != nil {
		t.Fatal(err)
	}
	got, audits, err := open(t, dir).Replay()
	if err != nil || len(audits) != 0 {
		t.Fatalf("err %v audits %v", err, audits)
	}
	if len(got) != 1 || got["a"].Phase != api.PhaseStalled || got["a"].Session.Key != "a-a1" || got["a"].Attempt != 1 {
		t.Fatalf("replayed %+v", got)
	}
}

// A kill -9 mid-write leaves a torn last line: the state is the valid prefix, the tail is kept aside
// and an audit event is appended.
func TestReplayTornTail(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	if err := s.Append("a", Event{Kind: KindDispatch, Time: t0, Ticket: tk("a"), Attempt: 1, Session: &api.Session{Key: "k"}}); err != nil {
		t.Fatal(err)
	}
	f, _ := os.OpenFile(filepath.Join(dir, "a.jsonl"), os.O_APPEND|os.O_WRONLY, 0o600)
	_, _ = f.WriteString(`{"seq":2,"kind":"ste`)
	_ = f.Close()
	got, audits, err := open(t, dir).Replay()
	if err != nil || len(audits) != 1 || got["a"].Phase != api.PhaseRunning {
		t.Fatalf("err %v audits %v got %+v", err, audits, got)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.jsonl.bad")); !strings.Contains(string(b), `"ste`) {
		t.Fatalf("bad tail not kept: %q", b)
	}
	// The next replay is clean and sees the audit line.
	s2 := open(t, dir)
	got, audits, _ = s2.Replay()
	if len(audits) != 0 || got["a"].Phase != api.PhaseRunning {
		t.Fatalf("second replay audits %v got %+v", audits, got)
	}
	if err := s2.Append("a", Event{Kind: KindSteer, Time: t0}); err != nil {
		t.Fatal(err)
	}
}

// A line whose recorded checksum does not match the folded state is a mismatch: state is rebuilt
// from the log before that line and an audit event is written.
func TestReplayChecksumMismatch(t *testing.T) {
	dir := t.TempDir()
	s := open(t, dir)
	_ = s.Append("a", Event{Kind: KindDispatch, Time: t0, Ticket: tk("a"), Attempt: 1, Session: &api.Session{Key: "k"}})
	_ = s.Append("a", Event{Kind: KindRetry, Time: t0, At: t0, Reason: "r"})
	p := filepath.Join(dir, "a.jsonl")
	b, _ := os.ReadFile(p)
	b = []byte(strings.Replace(string(b), `"attempt":1`, `"attempt":7`, 1)) // edit the first line
	_ = os.WriteFile(p, b, 0o600)
	got, audits, err := open(t, dir).Replay()
	if err != nil || len(audits) != 1 || !strings.Contains(audits[0], "checksum") {
		t.Fatalf("err %v audits %v", err, audits)
	}
	if _, ok := got["a"]; ok {
		t.Fatalf("nothing before the edited line is valid, got %+v", got)
	}
}

func TestOpenAndPath(t *testing.T) {
	if _, err := Open(filepath.Join(t.TempDir(), "x", "y")); err != nil {
		t.Fatalf("Open must create the directory: %v", err)
	}
	s := open(t, t.TempDir())
	if err := s.Append("a/../b", Event{Kind: KindEnd}); err != nil {
		t.Fatal(err)
	}
	if es, _ := os.ReadDir(s.dir); len(es) != 1 || strings.Contains(es[0].Name(), "/") || strings.HasPrefix(es[0].Name(), "..") {
		t.Fatalf("unsafe file name: %v", es)
	}
}

// Each way a log goes bad leaves the valid prefix, sets the bad tail aside and audits.
func TestReplayRepairs(t *testing.T) {
	good := func(s *Store) {
		_ = s.Append("a", Event{Kind: KindDispatch, Time: t0, Ticket: tk("a"), Attempt: 1, Session: &api.Session{Key: "k"}})
		_ = s.Append("a", Event{Kind: KindSteer, Time: t0})
		_ = s.Append("a", Event{Kind: KindEnd, Time: t0, Reason: "r"})
	}
	tests := []struct {
		name, want string
		edit       func(lines []string) string
	}{
		{"seq gap", "sequence", func(l []string) string { return l[0] + "\n" + l[2] + "\n" }},
		{"no final newline", "torn", func(l []string) string { return l[0] + "\n" + l[1] }},
		{"garbage line", "unreadable", func(l []string) string { return l[0] + "\nnot json\n" + l[2] + "\n" }},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			good(open(t, dir))
			p := filepath.Join(dir, "a.jsonl")
			b, _ := os.ReadFile(p)
			_ = os.WriteFile(p, []byte(tc.edit(strings.Split(strings.TrimSpace(string(b)), "\n"))), 0o600)
			got, audits, err := open(t, dir).Replay()
			if err != nil || len(audits) != 1 || !strings.Contains(audits[0], tc.want) || got["a"].Attempt != 1 {
				t.Fatalf("err %v audits %v got %+v", err, audits, got)
			}
		})
	}
}
