package core

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
)

type dirWorktrees struct{ dir string }

func (d dirWorktrees) Add(context.Context, api.Brief) (string, error) { return d.dir, nil }

// localRig runs a Core over the real local dispatcher with a fake agent binary that records its start.
func localRig(t *testing.T, tk api.Ticket) (*Core, string) {
	t.Helper()
	dir := t.TempDir()
	mark := filepath.Join(dir, "started")
	script := filepath.Join(dir, "claude")
	if err := os.WriteFile(script, []byte("#!/bin/sh\necho \"$@\" > "+mark+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	ld, err := local.New(ctx, local.Config{Worktrees: dirWorktrees{dir}, Binary: script, MaxConcurrent: 1})
	if err != nil {
		t.Fatal(err)
	}
	st, err := store.Open(filepath.Join(dir, "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	c, err := New(Deps{Tracker: listTracker{porttest.NewTracker(tk)}, Dispatcher: ld, Observer: porttest.NewObserver(), Store: st,
		Meter: meter.New(meter.Budgets{}, time.Now), Queue: &fakeQueue{}},
		Config{Reconcile: reconcile.Config{Tick: time.Minute}})
	if err != nil {
		t.Fatal(err)
	}
	return c, mark
}

func waitFile(t *testing.T, path string) {
	t.Helper()
	for end := time.Now().Add(5 * time.Second); time.Now().Before(end); time.Sleep(10 * time.Millisecond) {
		if _, err := os.Stat(path); err == nil {
			return
		}
	}
	t.Fatalf("the agent never started (%s)", path)
}

// Symphony 10.1: the dispatcher starts the session named for the brief. Core.Dispatch must
// hand the real local dispatcher the name brief.Name builds.
func TestDispatchStartsRealLocalSession(t *testing.T) {
	c, mark := localRig(t, tkt("7", 1))
	if err := c.Dispatch(context.Background(), "7"); err != nil {
		t.Fatal(err)
	}
	waitFile(t, mark)
}

// The reconcile loop names its briefs wrongly; the core fixes the name before the dispatcher sees it (Symphony 10.1).
func TestTickStartsRealLocalSession(t *testing.T) {
	c, mark := localRig(t, tkt("8", 1))
	c.Tick(context.Background())
	waitFile(t, mark)
}
