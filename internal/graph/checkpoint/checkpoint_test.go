package checkpoint

import (
	"context"
	"path/filepath"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "c.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func TestLatestOnEmptyThread(t *testing.T) {
	if _, ok, err := open(t).Latest(context.Background(), "5"); ok || err != nil {
		t.Fatalf("ok=%v err=%v, want no checkpoint", ok, err)
	}
}

// Put keeps every step under the upstream key (thread, namespace, id) and Latest returns the newest
// with its parent link; threads do not see each other.
func TestPutChainsParentsPerThread(t *testing.T) {
	s, ctx := open(t), context.Background()
	a, err := s.Put(ctx, "5", []byte(`{"node":"plan"}`), []byte(`{"step":0}`))
	if err != nil {
		t.Fatal(err)
	}
	b, err := s.Put(ctx, "5", []byte(`{"node":"build"}`), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Put(ctx, "6", []byte(`{"node":"other"}`), nil); err != nil {
		t.Fatal(err)
	}
	got, ok, err := s.Latest(ctx, "5")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if got.ID != b || got.ParentID != a || string(got.State) != `{"node":"build"}` || a == b {
		t.Fatalf("latest %+v, want id %s parent %s", got, b, a)
	}
}

// Writes belong to one checkpoint and one task. A repeat of the same (task, idx) replaces the row,
// so a task that is run again after a restart cannot double its output.
func TestWritesAreKeyedByTaskAndIndex(t *testing.T) {
	s, ctx := open(t), context.Background()
	id, _ := s.Put(ctx, "5", []byte(`{}`), nil)
	w := func(task string, idx int, v string) Write {
		return Write{Task: task, Idx: idx, Channel: "outcome", Value: []byte(v)}
	}
	for _, x := range []Write{w("plan", 0, `"pass"`), w("plan", 0, `"fail"`), w("build", 0, `"pass"`), w("build", 1, `"x"`)} {
		if err := s.PutWrites(ctx, "5", id, x); err != nil {
			t.Fatal(err)
		}
	}
	got, _, _ := s.Latest(ctx, "5")
	if len(got.Writes) != 3 || string(got.Writes[2].Value) != `"fail"` || got.Writes[2].Task != "plan" {
		t.Fatalf("writes %+v, want plan replaced and ordered by task, idx", got.Writes)
	}
	next, _ := s.Put(ctx, "5", []byte(`{}`), nil)
	if got, _, _ = s.Latest(ctx, "5"); got.ID != next || len(got.Writes) != 0 {
		t.Fatalf("a new checkpoint starts with no pending writes: %+v", got)
	}
}

func TestStateSurvivesReopen(t *testing.T) {
	p := filepath.Join(t.TempDir(), "c.db")
	s, _ := Open(p)
	_, _ = s.Put(context.Background(), "5", []byte(`{"node":"build"}`), nil)
	_ = s.Close()
	s, err := Open(p)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = s.Close() }()
	if got, ok, _ := s.Latest(context.Background(), "5"); !ok || string(got.State) != `{"node":"build"}` {
		t.Fatalf("reopened: %+v ok=%v", got, ok)
	}
}
