package reconcile

import (
	"context"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

var errCrash = "crash"

// fakePub counts publish calls. crashOpen makes OpenPR panic once, the way a killed process stops.
type fakePub struct {
	pushes, opens int
	crashOpen     bool
	number        int // PR number OpenPR returns; 0 means the PR already existed
}

func (f *fakePub) Push(context.Context, api.TicketID, int, string) error { f.pushes++; return nil }

func (f *fakePub) OpenPR(context.Context, api.TicketID, int, string) (int, error) {
	f.opens++
	if f.crashOpen {
		f.crashOpen = false
		panic(errCrash)
	}
	return f.number, nil
}

func tickCrash(ctx context.Context, d Deps, sp **State) (crashed bool) {
	defer func() { crashed = recover() == errCrash }()
	Tick(ctx, d, sp, cfg())
	return false
}

func publishSetup(t *testing.T) (dir string, tr api.Tracker, ob *porttest.Observer, disp api.Dispatcher, c *clock) {
	ob = porttest.NewObserver()
	ob.Set(api.Observation{Ticket: "a", Attempt: 1, Branch: "factory/a-a1", HasReport: true, LastPush: t0})
	return t.TempDir(), activeTracker{porttest.NewTracker(tkt("a"))}, ob, porttest.NewDispatcher(2), &clock{t0}
}

// Crash after push: the restart resumes at PR open. One push, one PR.
func TestCrashAfterPushResumesAtPROpen(t *testing.T) {
	dir, tr, ob, disp, c := publishSetup(t)
	pub := &fakePub{crashOpen: true, number: 7}
	ctx := context.Background()

	deps, _ := logDeps(t, dir, tr, ob, disp, c)
	deps.Publisher = pub
	var state *State
	if !tickCrash(ctx, deps, &state) {
		t.Fatal("setup: the fake should have crashed the first tick")
	}
	if pub.pushes != 1 || pub.opens != 1 {
		t.Fatalf("before restart: pushes=%d opens=%d, want 1 and 1", pub.pushes, pub.opens)
	}

	deps2, errs := logDeps(t, dir, tr, ob, disp, c) // new process, same log
	deps2.Publisher = pub
	var restarted *State
	Tick(ctx, deps2, &restarted, cfg())
	if len(*errs) != 0 {
		t.Fatalf("restart errors: %v", *errs)
	}
	if pub.pushes != 1 {
		t.Errorf("pushed %d times, want exactly 1", pub.pushes)
	}
	if pub.opens != 2 { // one that crashed, one that finished
		t.Errorf("PR open calls = %d, want 2 (crashed, then resumed)", pub.opens)
	}
}

// A ticket with every step recorded does no side effect on restart.
func TestFullyRecordedTicketDoesNothingOnRestart(t *testing.T) {
	dir, tr, ob, disp, c := publishSetup(t)
	pub := &fakePub{} // returns 0, so the ticket stays live and its log is not closed
	ctx := context.Background()

	deps, _ := logDeps(t, dir, tr, ob, disp, c)
	deps.Publisher = pub
	var state *State
	Tick(ctx, deps, &state, cfg())
	if pub.pushes != 1 || pub.opens != 1 {
		t.Fatalf("setup: pushes=%d opens=%d, want 1 and 1", pub.pushes, pub.opens)
	}

	deps2, _ := logDeps(t, dir, tr, ob, disp, c)
	deps2.Publisher = pub
	var restarted *State
	Tick(ctx, deps2, &restarted, cfg()) // the observer still shows no PR number
	if pub.pushes != 1 || pub.opens != 1 {
		t.Errorf("restart repeated a step: pushes=%d opens=%d, want 1 and 1", pub.pushes, pub.opens)
	}
}
