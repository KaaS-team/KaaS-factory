package shadow_test

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/dispatch/shadow"
)

type memWriter struct {
	recs []shadow.Record
	err  error
}

func (m *memWriter) Write(r shadow.Record) error {
	if m.err != nil {
		return m.err
	}
	m.recs = append(m.recs, r)
	return nil
}

// countingInner fails the test if anything but Name and Caps is called.
type countingInner struct {
	api.Dispatcher
	t     *testing.T
	calls int
}

func (c *countingInner) Dispatch(context.Context, api.Brief) (api.Session, error) {
	c.calls++
	return api.Session{}, nil
}
func (c *countingInner) Steer(context.Context, api.Session, string) error {
	c.calls++
	return nil
}
func (c *countingInner) Cancel(context.Context, api.Session) error { c.calls++; return nil }
func (c *countingInner) Usage(context.Context, api.Session) (api.Usage, error) {
	c.calls++
	return api.Usage{}, nil
}

func brief(t api.TicketID, attempt int) api.Brief {
	return api.Brief{Ticket: t, Attempt: attempt, Name: "b.md", Text: "do it", Repo: "o/r", Base: "main", Branch: "factory/x"}
}

// Acceptance 1: three Dispatch calls make zero inner Dispatch calls and three records.
func TestDispatchRecordsAndCallsNothingOnInner(t *testing.T) {
	inner := &countingInner{Dispatcher: porttest.NewDispatcher(2), t: t}
	w := &memWriter{}
	d := shadow.New(inner, w)
	for i := 1; i <= 3; i++ {
		s, err := d.Dispatch(context.Background(), brief("7", i))
		if err != nil {
			t.Fatal(err)
		}
		if s.Ticket != "7" || s.Attempt != i {
			t.Fatalf("session = %+v", s)
		}
	}
	if inner.calls != 0 {
		t.Fatalf("inner called %d times", inner.calls)
	}
	if len(w.recs) != 3 {
		t.Fatalf("records = %d", len(w.recs))
	}
	r := w.recs[0]
	if r.Action != shadow.ActionDispatch || r.Dispatcher != "fake" || r.Brief == nil || r.Brief.Text != "do it" || r.Session.ID == "" {
		t.Fatalf("record = %+v", r)
	}
}

// Acceptance 2: Name and Caps come from the inner dispatcher.
func TestNameAndCapsFromInner(t *testing.T) {
	inner := porttest.NewDispatcher(5)
	inner.CapsVal = api.Caps{MaxConcurrent: 5, FiresPerHour: 9, Remote: true}
	d := shadow.New(inner, &memWriter{})
	if d.Name() != "shadow:fake" {
		t.Fatalf("name = %q", d.Name())
	}
	if d.Caps() != inner.CapsVal {
		t.Fatalf("caps = %+v", d.Caps())
	}
}

// Acceptance 4: the same brief twice gives the same would-be session (spec 7.4).
func TestSameBriefSameSession(t *testing.T) {
	d := shadow.New(porttest.NewDispatcher(1), &memWriter{})
	a, _ := d.Dispatch(context.Background(), brief("7", 1))
	b, _ := d.Dispatch(context.Background(), brief("7", 1))
	c, _ := d.Dispatch(context.Background(), brief("7", 2))
	if a != b {
		t.Fatalf("not idempotent: %+v vs %+v", a, b)
	}
	if a.ID == c.ID || a.Key == c.Key {
		t.Fatalf("attempts share a session: %+v %+v", a, c)
	}
}

func TestSteerCancelUsage(t *testing.T) {
	inner := &countingInner{Dispatcher: porttest.NewDispatcher(1), t: t}
	w := &memWriter{}
	d := shadow.New(inner, w)
	s, _ := d.Dispatch(context.Background(), brief("7", 1))
	if err := d.Steer(context.Background(), s, "go left"); err != nil {
		t.Fatal(err)
	}
	if err := d.Cancel(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	u, err := d.Usage(context.Background(), s)
	if err != nil || u != (api.Usage{}) {
		t.Fatalf("usage = %+v, %v", u, err)
	}
	if inner.calls != 0 {
		t.Fatalf("inner called %d times", inner.calls)
	}
	if len(w.recs) != 3 || w.recs[1].Action != shadow.ActionSteer || w.recs[1].Message != "go left" || w.recs[2].Action != shadow.ActionCancel {
		t.Fatalf("records = %+v", w.recs)
	}
	if w.recs[1].Ticket != "7" {
		t.Fatalf("ticket = %q", w.recs[1].Ticket)
	}
}

func TestWriterErrorSurfaces(t *testing.T) {
	boom := errors.New("disk full")
	d := shadow.New(porttest.NewDispatcher(1), &memWriter{err: boom})
	s, err := d.Dispatch(context.Background(), brief("7", 1))
	if !errors.Is(err, boom) {
		t.Fatalf("dispatch err = %v", err)
	}
	_ = s
	if err := d.Steer(context.Background(), api.Session{}, "x"); !errors.Is(err, boom) {
		t.Fatalf("steer err = %v", err)
	}
	if err := d.Cancel(context.Background(), api.Session{}); !errors.Is(err, boom) {
		t.Fatalf("cancel err = %v", err)
	}
}

func TestRecordTimeFromClock(t *testing.T) {
	w := &memWriter{}
	now := time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)
	d := shadow.NewWithClock(porttest.NewDispatcher(1), w, func() time.Time { return now })
	_, _ = d.Dispatch(context.Background(), brief("7", 1))
	if !w.recs[0].Time.Equal(now) {
		t.Fatalf("time = %v", w.recs[0].Time)
	}
}
