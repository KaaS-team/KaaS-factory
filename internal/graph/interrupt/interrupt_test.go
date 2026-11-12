package interrupt

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

func open(t *testing.T, path string) (*Book, *sql.DB) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	b, err := Open(db)
	if err != nil {
		t.Fatal(err)
	}
	return b, db
}

const approve = `{"type":"object","properties":{"outcome":{"enum":["pass","revise"]}},"required":["outcome"]}`

func TestInterruptReturnsPendingWithStableID(t *testing.T) {
	ctx := context.Background()
	b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
	_, err := b.Task("t1").Interrupt(ctx, json.RawMessage(`{"q":"ok?"}`), json.RawMessage(approve))
	var p *Pending
	if !errors.As(err, &p) {
		t.Fatalf("want *Pending, got %v", err)
	}
	if string(p.Payload) != `{"q":"ok?"}` || p.ID == "" {
		t.Fatalf("bad pending %+v", p)
	}
	// A fresh run of the same task raises the same id (langgraph Interrupt.id).
	_, err2 := b.Task("t1").Interrupt(ctx, json.RawMessage(`{"q":"ok?"}`), nil)
	var p2 *Pending
	if !errors.As(err2, &p2) || p2.ID != p.ID {
		t.Fatalf("id not stable: %v vs %v", p, p2)
	}
	_, err3 := b.Task("t2").Interrupt(ctx, nil, nil)
	var p3 *Pending
	if !errors.As(err3, &p3) || p3.ID == p.ID {
		t.Fatalf("ids of different threads must differ")
	}
}

func TestApprovalSurvivesRestart(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "i.db")
	b, db := open(t, path)
	if _, err := b.Task("t1").Interrupt(ctx, json.RawMessage(`"plan"`), json.RawMessage(approve)); err == nil {
		t.Fatal("want pending")
	}
	_ = db.Close()

	b, _ = open(t, path)
	pend, err := b.Pending(ctx, "t1")
	if err != nil || len(pend) != 1 {
		t.Fatalf("pending after restart: %v %v", pend, err)
	}
	if err := b.Resume(ctx, "t1", json.RawMessage(`{"outcome":"pass"}`)); err != nil {
		t.Fatal(err)
	}
	got, err := b.Task("t1").Interrupt(ctx, json.RawMessage(`"plan"`), nil)
	if err != nil || string(got) != `{"outcome":"pass"}` {
		t.Fatalf("resume value: %s %v", got, err)
	}
}

func TestResumeValidatesAgainstSchema(t *testing.T) {
	ctx := context.Background()
	for _, tc := range []struct {
		name, schema, value string
		wantErr             bool
	}{
		{"valid", approve, `{"outcome":"revise"}`, false},
		{"wrong enum", approve, `{"outcome":"maybe"}`, true},
		{"missing field", approve, `{}`, true},
		{"not json", approve, `nope`, true},
		{"no schema accepts any", ``, `42`, false},
		{"bad schema", `{"type":"nonsense"}`, `1`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
			var sc json.RawMessage
			if tc.schema != "" {
				sc = json.RawMessage(tc.schema)
			}
			_, _ = b.Task("t").Interrupt(ctx, nil, sc)
			err := b.Resume(ctx, "t", json.RawMessage(tc.value))
			if (err != nil) != tc.wantErr {
				t.Fatalf("err=%v wantErr=%v", err, tc.wantErr)
			}
			if tc.wantErr {
				// A rejected value leaves the interrupt pending.
				if p, _ := b.Pending(ctx, "t"); len(p) != 1 {
					t.Fatalf("rejected resume must keep interrupt pending, got %d", len(p))
				}
			}
		})
	}
}

func TestResumeWithNothingPending(t *testing.T) {
	b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
	if err := b.Resume(context.Background(), "none", json.RawMessage(`1`)); !errors.Is(err, ErrNothingPending) {
		t.Fatalf("got %v", err)
	}
}

func TestMultipleInterruptsMatchedByOrder(t *testing.T) {
	ctx := context.Background()
	b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
	run := func() (a, c json.RawMessage, err error) {
		task := b.Task("t")
		if a, err = task.Interrupt(ctx, json.RawMessage(`"first"`), nil); err != nil {
			return
		}
		c, err = task.Interrupt(ctx, json.RawMessage(`"second"`), nil)
		return
	}
	_, _, err := run()
	var p *Pending
	if !errors.As(err, &p) || string(p.Payload) != `"first"` {
		t.Fatalf("first: %v", err)
	}
	first := p.ID
	_ = b.Resume(ctx, "t", json.RawMessage(`"A"`))
	_, _, err = run()
	if !errors.As(err, &p) || string(p.Payload) != `"second"` || p.ID == first {
		t.Fatalf("second: %v", err)
	}
	_ = b.Resume(ctx, "t", json.RawMessage(`"B"`))
	a, c, err := run()
	if err != nil || string(a) != `"A"` || string(c) != `"B"` {
		t.Fatalf("order: %s %s %v", a, c, err)
	}
}

func TestOnceRunsSideEffectOnceAcrossReplays(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "i.db")
	b, db := open(t, path)
	calls := 0
	fx := func(string) error { calls++; return nil }
	node := func(b *Book) error {
		task := b.Task("t")
		if err := task.Once(ctx, "comment", fx); err != nil {
			return err
		}
		_, err := task.Interrupt(ctx, nil, nil)
		return err
	}
	if err := node(b); err == nil {
		t.Fatal("want pending")
	}
	_ = db.Close()
	b, _ = open(t, path) // restart: the node replays from the top
	_ = node(b)
	_ = b.Resume(ctx, "t", json.RawMessage(`1`))
	if err := node(b); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatalf("side effect ran %d times, want 1", calls)
	}
}

func TestOnceRetriesAfterFailure(t *testing.T) {
	ctx := context.Background()
	b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
	calls := 0
	fail := errors.New("boom")
	if err := b.Task("t").Once(ctx, "k", func(string) error { calls++; return fail }); !errors.Is(err, fail) {
		t.Fatal(err)
	}
	if err := b.Task("t").Once(ctx, "k", func(string) error { calls++; return nil }); err != nil {
		t.Fatal(err)
	}
	if calls != 2 {
		t.Fatalf("calls=%d", calls)
	}
}

func TestDoneClearsThread(t *testing.T) {
	ctx := context.Background()
	b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
	_, _ = b.Task("t").Interrupt(ctx, nil, nil)
	if err := b.Done(ctx, "t"); err != nil {
		t.Fatal(err)
	}
	if p, _ := b.Pending(ctx, "t"); len(p) != 0 {
		t.Fatal("pending after Done")
	}
}

func TestParallelInterruptsAnsweredOldestFirst(t *testing.T) {
	ctx := context.Background()
	b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
	task := b.Task("t")
	_, _ = task.Interrupt(ctx, json.RawMessage(`"one"`), nil)
	_, _ = task.Interrupt(ctx, json.RawMessage(`"two"`), nil) // raised without waiting for the first
	if err := b.Resume(ctx, "t", json.RawMessage(`"A"`)); err != nil {
		t.Fatal(err)
	}
	got, err := b.Task("t").Interrupt(ctx, nil, nil)
	if err != nil || string(got) != `"A"` {
		t.Fatalf("first interrupt got %s %v", got, err)
	}
}

// Two answers racing for one interrupt: exactly one is recorded, the other is told nothing is waiting,
// and the stored answer is never replaced after it was given.
func TestConcurrentResumeAnswersOnce(t *testing.T) {
	ctx := context.Background()
	for i := 0; i < 100; i++ {
		b, _ := open(t, filepath.Join(t.TempDir(), "i.db"))
		if _, err := b.Task("t").Interrupt(ctx, nil, nil); err == nil {
			t.Fatal("want pending")
		}
		errs := make(chan error, 2)
		for _, v := range []string{`"a"`, `"b"`} {
			go func() { errs <- b.Resume(ctx, "t", json.RawMessage(v)) }()
		}
		e1, e2 := <-errs, <-errs
		if (e1 == nil) == (e2 == nil) || (e1 != nil && !errors.Is(e1, ErrNothingPending)) || (e2 != nil && !errors.Is(e2, ErrNothingPending)) {
			t.Fatalf("round %d: want one success and one ErrNothingPending, got %v and %v", i, e1, e2)
		}
	}
}
