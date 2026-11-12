package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/graph/checkpoint"
	"github.com/KaaS-team/factory/internal/meter"
)

// stageDispatcher records every brief and makes the observer report the dispatched node as finished:
// a branch, a report and a PR for that attempt. Verify nodes report red checks for the first failVerify runs.
type stageDispatcher struct {
	*porttest.Dispatcher
	obs        *scriptedObserver
	mu         sync.Mutex
	briefs     []api.Brief
	failVerify int
}

func (d *stageDispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	d.mu.Lock()
	d.briefs = append(d.briefs, b)
	green := true
	if b.Node == "verify" && d.failVerify > 0 {
		d.failVerify--
		green = false
	}
	d.mu.Unlock()
	d.obs.set(api.Observation{Ticket: b.Ticket, Attempt: b.Attempt, Branch: b.Branch, HasReport: true, PR: 100 + b.Attempt, ChecksGreen: &green, LastPush: time.Now()})
	return d.Dispatcher.Dispatch(ctx, b)
}

func (d *stageDispatcher) seen() []api.Brief {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]api.Brief(nil), d.briefs...)
}

// scriptedObserver answers by attempt, like the real observer does.
type scriptedObserver struct {
	mu  sync.Mutex
	obs map[int]api.Observation
}

func (s *scriptedObserver) set(o api.Observation) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.obs[o.Attempt] = o
}

func (s *scriptedObserver) Observe(_ context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if o, ok := s.obs[attempt]; ok {
		return o, nil
	}
	return api.Observation{Ticket: id, Attempt: attempt}, nil
}

// phaseTracker remembers the last phase set per ticket, safely for the test to read.
type phaseTracker struct {
	*porttest.Tracker
	mu    sync.Mutex
	last  map[api.TicketID]api.Phase
	notes []string
}

func (p *phaseTracker) SetPhase(ctx context.Context, id api.TicketID, ph api.Phase) error {
	p.mu.Lock()
	p.last[id] = ph
	p.mu.Unlock()
	return p.Tracker.SetPhase(ctx, id, ph)
}

func (p *phaseTracker) Comment(ctx context.Context, id api.TicketID, body string) error {
	p.mu.Lock()
	p.notes = append(p.notes, body)
	p.mu.Unlock()
	return p.Tracker.Comment(ctx, id, body)
}

func (p *phaseTracker) phase(id api.TicketID) api.Phase {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.last[id]
}

// runStages runs `factory run --headless` on fakes in a temp repo holding files until the ticket
// reaches want, and returns the briefs the dispatcher saw.
func runStages(t *testing.T, files map[string]string, ticket api.Ticket, failVerify int, want api.Phase) []api.Brief {
	t.Helper()
	dir := t.TempDir()
	t.Chdir(dir)
	for name, body := range files {
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("FACTORY_POLL_INTERVAL", "10ms")
	t.Setenv("FACTORY_SLOTS", "1")
	trk := &phaseTracker{Tracker: porttest.NewTracker(ticket), last: map[api.TicketID]api.Phase{}}
	obs := &scriptedObserver{obs: map[int]api.Observation{}}
	disp := &stageDispatcher{Dispatcher: porttest.NewDispatcher(1), obs: obs, failVerify: failVerify}
	old := newDeps
	newDeps = func(config.Config) (core.Deps, error) {
		return core.Deps{Tracker: trk, Dispatcher: disp, Observer: obs, Store: nopStore{},
			Meter: meter.New(meter.Budgets{}, time.Now), Queue: notConfiguredQueue{}}, nil
	}
	t.Cleanup(func() { newDeps = old })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out syncBuf
	root := newRoot()
	root.SetOut(&out)
	root.SetErr(&syncBuf{})
	root.SetArgs([]string{"run", "--headless"})
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()
	for ctx.Err() == nil {
		if trk.phase(ticket.ID) == want {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := trk.phase(ticket.ID); got != want {
		t.Fatalf("phase = %s, want %s; comments %q; output %s", got, want, trk.notes, out.String())
	}
	return disp.seen()
}

type step struct {
	Node    string
	Attempt int
	Model   string
}

func steps(bs []api.Brief) []step {
	var out []step
	for _, b := range bs {
		out = append(out, step{b.Node, b.Attempt, b.Model})
	}
	return out
}

const tierConfig = `{"repo":"a/b","models":{"small":"s","large":"l"}}`

// TestRunWalksDefaultGraph: with no workflow file a ticket goes build, then verify in a fresh session, then
// done; a verify fail follows the fail edge back to build (Symphony 7.1 claim states, 8.1 dispatch).
func TestRunWalksDefaultGraph(t *testing.T) {
	tk := api.Ticket{ID: "1", Title: "one", Body: "body", Repo: "a/b"}
	cfg := map[string]string{".factory/config.json": tierConfig}
	t.Run("pass", func(t *testing.T) {
		got := steps(runStages(t, cfg, tk, 0, api.PhaseDone))
		want := []step{{"build", 1, "small"}, {"verify", 2, "large"}}
		if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
			t.Fatalf("briefs %+v, want %+v", got, want)
		}
	})
	t.Run("verify fail goes back to build", func(t *testing.T) {
		got := steps(runStages(t, cfg, tk, 1, api.PhaseDone))
		want := []step{{"build", 1, "small"}, {"verify", 2, "large"}, {"build", 3, "small"}, {"verify", 4, "large"}}
		if len(got) != len(want) {
			t.Fatalf("briefs %+v, want %+v", got, want)
		}
		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("brief %d = %+v, want %+v", i, got[i], want[i])
			}
		}
	})
	t.Run("student budget spent builds on the large tier", func(t *testing.T) {
		got := steps(runStages(t, cfg, tk, 2, api.PhaseDone))
		if len(got) != 6 || got[4] != (step{"build", 5, "large"}) {
			t.Fatalf("briefs %+v, want the third build on large", got)
		}
	})
	t.Run("verify keeps failing: a human takes over", func(t *testing.T) {
		got := steps(runStages(t, cfg, tk, 99, api.PhaseNeedsHuman))
		if len(got) != 6 {
			t.Fatalf("briefs %+v, want three build and verify rounds", got)
		}
	})
	t.Run("no models configured: no tier in the brief", func(t *testing.T) {
		got := steps(runStages(t, nil, tk, 0, api.PhaseDone))
		if len(got) != 2 || got[0].Model != "" || got[1].Model != "" {
			t.Fatalf("briefs %+v, want none with a tier", got)
		}
	})
}

// TestRunHonorsRepoWorkflow: a pinned node tier wins over the tutor, and a repo file replaces the default.
func TestRunHonorsRepoWorkflow(t *testing.T) {
	wf := "name: issue-to-pr\nsteps:\n  build:\n    uses: build\n    next: verify\n    tier: large\n  verify:\n    uses: verify\n    tier: small\n    reject: build\n"
	got := steps(runStages(t, map[string]string{".factory/config.json": tierConfig, ".factory/workflows/issue-to-pr.yml": wf},
		api.Ticket{ID: "2", Title: "two", Repo: "a/b"}, 0, api.PhaseDone))
	if len(got) != 2 || got[0] != (step{"build", 1, "large"}) || got[1] != (step{"verify", 2, "small"}) {
		t.Fatalf("briefs %+v, want pinned tiers", got)
	}
	// A ticket may name its workflow; a repo file of that name is used.
	three := "name: three\nsteps:\n  build:\n    uses: build\n    next: verify\n  verify:\n    uses: verify\n    next: report\n    reject: build\n  report:\n    uses: report\n"
	got = steps(runStages(t, map[string]string{".factory/workflows/three.yml": three},
		api.Ticket{ID: "3", Title: "t", Repo: "a/b", Workflow: "three"}, 0, api.PhaseDone))
	if len(got) != 3 || got[2].Node != "report" {
		t.Fatalf("briefs %+v, want build, verify, report", got)
	}
}

// TestRunRefusesBadWorkflow: an unknown template variable fails at load, naming the file and the line.
func TestRunRefusesBadWorkflow(t *testing.T) {
	t.Chdir(t.TempDir())
	if err := os.MkdirAll(".factory/workflows", 0o755); err != nil {
		t.Fatal(err)
	}
	bad := "name: issue-to-pr\nprompt: x\nsteps:\n  build:\n    uses: build\n    prompt: |\n      fine\n      {{ nope.x }}\n"
	if err := os.WriteFile(".factory/workflows/issue-to-pr.yml", []byte(bad), 0o644); err != nil {
		t.Fatal(err)
	}
	_, err := workflowGraph(".", "")
	if err == nil || !strings.Contains(err.Error(), "issue-to-pr.yml") || !strings.Contains(err.Error(), "line 8") || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("got %v, want the file, line 8 and the variable", err)
	}
}

// TestRunSavesWorkflowCheckpoints: `factory run` keeps each ticket's place in its workflow in
// .factory/cache/checkpoints.db, so a restart resumes there; without the store it leaves no file.
func TestRunSavesWorkflowCheckpoints(t *testing.T) {
	tk := api.Ticket{ID: "1", Title: "one", Body: "body", Repo: "a/b"}
	runStages(t, map[string]string{".factory/config.json": tierConfig}, tk, 0, api.PhaseDone)
	st, err := checkpoint.Open(checkpointPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	cp, ok, err := st.Latest(context.Background(), string(tk.ID))
	if err != nil || !ok {
		t.Fatalf("no checkpoint for ticket %s: ok=%v err=%v", tk.ID, ok, err)
	}
	var s struct{ Node string }
	if err := json.Unmarshal(cp.State, &s); err != nil || s.Node != graph.End {
		t.Fatalf("latest checkpoint node = %q (err %v), want %q", s.Node, err, graph.End)
	}
}
