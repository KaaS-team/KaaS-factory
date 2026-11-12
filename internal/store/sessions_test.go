package store

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

func TestPutSessionThenLatestReturnsNewestAttempt(t *testing.T) {
	ctx := context.Background()
	s := openTemp(t)
	mk := func(a int, id string) api.Session {
		return api.Session{Ticket: "7", Attempt: a, Dispatcher: "routines", ID: id, URL: "https://x/" + id, StartedAt: time.Unix(int64(a), 0).UTC()}
	}
	for _, x := range []api.Session{mk(2, "s2"), mk(1, "s1"), mk(3, "s3a")} {
		if err := s.PutSession(ctx, x); err != nil {
			t.Fatal(err)
		}
	}
	// a repeated put of an attempt replaces it
	if err := s.PutSession(ctx, mk(3, "s3b")); err != nil {
		t.Fatal(err)
	}
	got, err := s.LatestSession(ctx, "7")
	if err != nil {
		t.Fatal(err)
	}
	want := mk(3, "s3b")
	if got.ID != want.ID || got.Attempt != 3 || got.Dispatcher != "routines" || got.URL != want.URL || !got.StartedAt.Equal(want.StartedAt) || got.Ticket != "7" {
		t.Fatalf("got %+v", got)
	}
}

func TestLatestSessionUnknownTicketIsTypedNotFound(t *testing.T) {
	_, err := openTemp(t).LatestSession(context.Background(), "nope")
	if !errors.Is(err, ErrSessionNotRecorded) {
		t.Fatalf("err %v", err)
	}
	if !strings.Contains(err.Error(), "not recorded") {
		t.Fatalf("message %q does not tell the operator", err)
	}
}

func TestRebuildLeavesSessionsEmptyAndValid(t *testing.T) {
	ctx := context.Background()
	s := openTemp(t)
	tr, o := fakes()
	if err := s.Rebuild(ctx, tr, o); err != nil {
		t.Fatal(err)
	}
	for _, id := range []api.TicketID{"1", "2", "3"} {
		if _, err := s.LatestSession(ctx, id); !errors.Is(err, ErrSessionNotRecorded) {
			t.Fatalf("ticket %s: %v", id, err)
		}
	}
	var n int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM dispatched_sessions`).Scan(&n); err != nil || n != 0 {
		t.Fatalf("rows %d err %v", n, err)
	}
	// still writable after the rebuild
	if err := s.PutSession(ctx, api.Session{Ticket: "1", Attempt: 1, Dispatcher: "local", ID: "a"}); err != nil {
		t.Fatal(err)
	}
}
