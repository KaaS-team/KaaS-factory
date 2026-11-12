// Package conformance is a table of behaviours every crypt.Store must show; a store's own test
// calls Run with a constructor. Cases follow langgraph's checkpoint-conformance (put, get, latest,
// prune) ported to Go.
package conformance

import (
	"bytes"
	"context"
	"testing"

	"github.com/KaaS-team/factory/internal/store/crypt"
)

// Run runs every conformance case against a fresh store from newStore.
func Run(t *testing.T, newStore func(t *testing.T) crypt.Store) {
	t.Helper()
	ctx := context.Background()
	cases := []struct {
		name string
		run  func(t *testing.T, s crypt.Store)
	}{
		{"get missing", func(t *testing.T, s crypt.Store) {
			if _, ok, err := s.Get(ctx, "t", "x"); err != nil || ok {
				t.Fatalf("got ok=%v err=%v", ok, err)
			}
		}},
		{"latest empty thread", func(t *testing.T, s crypt.Store) {
			if _, ok, err := s.Latest(ctx, "t"); err != nil || ok {
				t.Fatalf("got ok=%v err=%v", ok, err)
			}
		}},
		{"put then get round trips", func(t *testing.T, s crypt.Store) {
			put(t, s, "t", "a", "json", `{"n":1}`)
			r, ok, err := s.Get(ctx, "t", "a")
			if err != nil || !ok || r.Type != "json" || !bytes.Equal(r.Data, []byte(`{"n":1}`)) {
				t.Fatalf("got %+v ok=%v err=%v", r, ok, err)
			}
		}},
		{"put replaces and becomes latest", func(t *testing.T, s crypt.Store) {
			put(t, s, "t", "a", "json", "1")
			put(t, s, "t", "b", "json", "2")
			put(t, s, "t", "a", "json", "3")
			r, _, _ := s.Latest(ctx, "t")
			if r.ID != "a" || string(r.Data) != "3" {
				t.Fatalf("latest = %+v", r)
			}
		}},
		{"threads are isolated", func(t *testing.T, s crypt.Store) {
			put(t, s, "t1", "a", "json", "1")
			if _, ok, _ := s.Get(ctx, "t2", "a"); ok {
				t.Fatal("row leaked across threads")
			}
			if _, ok, _ := s.Latest(ctx, "t2"); ok {
				t.Fatal("latest leaked across threads")
			}
		}},
		{"prune keeps latest per thread", func(t *testing.T, s crypt.Store) {
			put(t, s, "t1", "a", "json", "1")
			put(t, s, "t1", "b", "json", "2")
			put(t, s, "t2", "c", "json", "3")
			put(t, s, "t2", "d", "json", "4")
			put(t, s, "t2", "e", "json", "5")
			n, err := s.PruneKeepLatest(ctx)
			if err != nil || n != 3 {
				t.Fatalf("pruned %d err=%v, want 3", n, err)
			}
			for thread, want := range map[string]string{"t1": "b", "t2": "e"} {
				if r, ok, _ := s.Latest(ctx, thread); !ok || r.ID != want {
					t.Fatalf("%s latest = %+v", thread, r)
				}
			}
			if _, ok, _ := s.Get(ctx, "t1", "a"); ok {
				t.Fatal("old row survived prune")
			}
			if n, _ := s.PruneKeepLatest(ctx); n != 0 {
				t.Fatalf("second prune deleted %d", n)
			}
		}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) { c.run(t, newStore(t)) })
	}
}

func put(t *testing.T, s crypt.Store, thread, id, typ, data string) {
	t.Helper()
	if err := s.Put(context.Background(), crypt.Row{Thread: thread, ID: id, Type: typ, Data: []byte(data)}); err != nil {
		t.Fatal(err)
	}
}
