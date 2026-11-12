package logs

import (
	"bytes"
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/store"
)

type fakeRunLog struct {
	pages []Page
	ids   []string
	curs  []string
}

func (f *fakeRunLog) RunLog(_ context.Context, id, cursor string) (Page, error) {
	f.ids = append(f.ids, id)
	f.curs = append(f.curs, cursor)
	i := len(f.curs) - 1
	if i >= len(f.pages) {
		i = len(f.pages) - 1
	}
	return f.pages[i], nil
}

func newStore(t *testing.T) *store.Store {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "f.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return st
}

func TestStoreSessionFeedsBackends(t *testing.T) {
	ctx := context.Background()
	st := newStore(t)
	rl := &fakeRunLog{pages: []Page{
		{Events: []Event{{Time: time.Unix(1, 0), Kind: "a", Text: "one"}, {Time: time.Unix(2, 0), Kind: "a", Text: "two"}}, Next: "c1", More: true},
		{Events: []Event{{Time: time.Unix(3, 0), Kind: "a", Text: "three"}}, Next: "c2", Done: true},
	}}
	b := Backends{Latest: st.LatestSession, Factories: map[string]func(api.Session) (Source, error){"routines": RoutinesFactory(rl)}}

	if _, err := b.Source(ctx, "9"); !errors.Is(err, store.ErrSessionNotRecorded) || !strings.Contains(err.Error(), "not recorded") {
		t.Fatalf("unknown ticket: %v", err)
	}
	for _, s := range []api.Session{
		{Ticket: "9", Attempt: 1, Dispatcher: "routines", ID: "old"},
		{Ticket: "9", Attempt: 2, Dispatcher: "routines", ID: "sess_2"},
	} {
		if err := st.PutSession(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	src, err := b.Source(ctx, "9")
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Print(ctx, &out, src, Options{}); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 3 || !strings.HasSuffix(lines[0], "one") || !strings.HasSuffix(lines[1], "two") || !strings.HasSuffix(lines[2], "three") {
		t.Fatalf("lines %q", lines)
	}
	if rl.ids[0] != "sess_2" || rl.curs[0] != "" || rl.curs[1] != "c1" {
		t.Fatalf("client saw ids %v cursors %v", rl.ids, rl.curs)
	}
}

func TestRoutinesFollowRunsUntilContextEnds(t *testing.T) {
	rl := &fakeRunLog{pages: []Page{
		{Events: []Event{{ID: "1", Kind: "k", Text: "first"}}, Next: "c1"},
		{Events: []Event{{ID: "2", Kind: "k", Text: "second"}}, Next: "c2"},
		{Next: "c2"},
	}}
	src, err := RoutinesFactory(rl)(api.Session{ID: "s"})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	var out bytes.Buffer
	err = Print(ctx, &out, src, Options{Follow: true, Interval: 5 * time.Millisecond})
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("follow must end with ctx error, got %v", err)
	}
	if got := strings.Count(out.String(), "\n"); got != 2 || len(rl.curs) < 3 {
		t.Fatalf("out %q polls %d", out.String(), len(rl.curs))
	}
}

func TestRoutinesFactoryNeedsSessionID(t *testing.T) {
	if _, err := RoutinesFactory(&fakeRunLog{})(api.Session{}); err == nil {
		t.Fatal("empty session id must fail")
	}
}
