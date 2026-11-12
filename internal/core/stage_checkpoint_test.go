package core

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/graph/checkpoint"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
)

const chainWorkflow = `steps:
  plan: { uses: plan, next: build }
  build: { uses: build, next: ship }
  ship: { uses: build }
`

// daemon starts a Core over fresh fakes and the given checkpoint store, as a process restart would:
// everything the old process held in memory is gone.
func daemon(t *testing.T, cp Checkpointer, observed ...api.Observation) (*Core, *porttest.Dispatcher, map[string]api.Brief) {
	t.Helper()
	g, err := graph.ParseYAML("w", []byte(chainWorkflow))
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t, 2, meter.Budgets{}, tkt("5", 1))
	briefs := map[string]api.Brief{}
	for _, o := range observed {
		r.obs.Set(o)
	}
	c, err := New(Deps{Tracker: r.tr, Dispatcher: briefDisp{r.disp, briefs}, Observer: r.obs, Store: r.st, Meter: r.m, Queue: r.mq, Clock: r.clk,
		Stages:  &Stages{Graph: func(string) (*graph.Graph, error) { return g, nil }, Checkpoints: cp},
		OnError: func(err error) { t.Errorf("loop error: %v", err) }},
		Config{Reconcile: reconcile.Config{Tick: 30 * time.Second}})
	if err != nil {
		t.Fatal(err)
	}
	return c, r.disp, briefs
}

func nodes(briefs map[string]api.Brief) (out []string) {
	for _, b := range briefs {
		out = append(out, b.Node)
	}
	return out
}

func openCP(t *testing.T) *checkpoint.Store {
	t.Helper()
	cp, err := checkpoint.Open(filepath.Join(t.TempDir(), "cp.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cp.Close() })
	return cp
}

// Killing the daemon after the plan node finished and restarting runs build, not plan again
// (Symphony 14.3: restart recovery; a finished node is not dispatched twice).
func TestRestartDoesNotRedispatchFinishedNodes(t *testing.T) {
	cases := []struct {
		name     string
		withCP   bool
		wantNode string
		wantAtt  int
	}{
		{"checkpointed: resumes at build on the next attempt number", true, "build", 2},
		{"no checkpoint: starts over at plan", false, "plan", 1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()
			var cp Checkpointer
			if tc.withCP {
				cp = openCP(t)
			}
			c, _, briefs := daemon(t, cp)
			c.Tick(ctx) // dispatches plan
			c.d.Observer.(*porttest.Observer).Set(api.Observation{Ticket: "5", Attempt: 1, Branch: "factory/5-a1", HasReport: true, PR: 3, LastPush: t0})
			c.Tick(ctx) // plan finishes; the loop moves on to build
			if len(briefs) < 1 {
				t.Fatal("the first daemon dispatched nothing")
			}

			c2, d2, briefs2 := daemon(t, cp) // the restart
			c2.Tick(ctx)
			if len(d2.Sessions) != 1 {
				t.Fatalf("restarted daemon started %d sessions (%v), want 1", len(d2.Sessions), nodes(briefs2))
			}
			for _, b := range briefs2 {
				if b.Node != tc.wantNode || b.Attempt != tc.wantAtt {
					t.Fatalf("restart dispatched node %s attempt %d, want %s attempt %d", b.Node, b.Attempt, tc.wantNode, tc.wantAtt)
				}
			}
		})
	}
}

// A node's result is saved before the graph moves on. If the process dies in between, the restart
// finds the result and takes it, so the node is not run again to get the same answer.
func TestRestartAppliesSavedResultOfFinishedNode(t *testing.T) {
	ctx := context.Background()
	cp := openCP(t)
	state := []byte(`{"Workflow":"","Node":"plan","Base":0}`)
	id, err := cp.Put(ctx, "5", state, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := cp.PutWrites(ctx, "5", id, checkpoint.Write{Task: "plan", Channel: outcomeChannel, Value: []byte(`{"Outcome":"pass","Attempts":2}`)}); err != nil {
		t.Fatal(err)
	}
	c, _, _ := daemon(t, cp, api.Observation{Ticket: "5", Attempt: 1, Branch: "factory/5-a1", HasReport: true, PR: 3, LastPush: t0})
	c.Tick(ctx) // recover: plan a1 is running and its report is in
	c.Tick(ctx)
	got, ok, err := cp.Latest(ctx, "5")
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	// Base 2 is the saved result's attempt count; the live observation alone would say 1.
	if !strings.Contains(string(got.State), `"Node":"build"`) || !strings.Contains(string(got.State), `"Base":2`) || len(got.Writes) != 0 {
		t.Fatalf("after the restart the checkpoint is %s with %d writes, want node build, base 2 and none", got.State, len(got.Writes))
	}
}
