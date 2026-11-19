package github_test

import (
	"context"
	"net/http"
	"testing"

	"github.com/KaaS-team/factory/internal/audit"
)

type memSink struct{ got []audit.Entry }

func (m *memSink) Write(_ context.Context, e audit.Entry) error { m.got = append(m.got, e); return nil }

// A comment on the thread leaves one audit record naming the action, the ticket and the result.
func TestCommentIsAudited(t *testing.T) {
	f := newFake(t)
	f.serve(t, "POST /repos/o/r/issues/7/comments", "comment_created.json", http.StatusCreated)
	tr := f.tracker(t)
	m := &memSink{}
	defer audit.SetSink(m)()
	if err := tr.Comment(context.Background(), "7", "hi"); err != nil {
		t.Fatal(err)
	}
	_ = tr.Comment(context.Background(), "x", "bad id")
	if len(m.got) != 2 {
		t.Fatalf("records = %d, want 2", len(m.got))
	}
	a := m.got[0].Attributes
	if a[audit.KeyAction] != "tracker.comment" || a[audit.KeyTicket] != "7" || a[audit.KeyResult] != "ok" {
		t.Errorf("first record = %v", a)
	}
	if m.got[1].Attributes[audit.KeyResult] != "error" {
		t.Errorf("failed write must record error, got %v", m.got[1].Attributes)
	}
}
