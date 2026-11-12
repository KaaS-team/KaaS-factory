package core

import (
	"context"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

const twoNodeWorkflow = `steps:
  plan: { uses: plan, next: build }
  build: { uses: build }
`

// restarted throws the rig's Core away and builds a new one over the same tracker, dispatcher and observer.
func restarted(t *testing.T, tr api.Tracker, r *rig, g *graph.Graph, briefs map[string]api.Brief) *Core {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "s2.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	c, err := New(Deps{Tracker: tr, Dispatcher: briefDisp{r.disp, briefs}, Observer: r.obs, Store: st, Meter: r.m, Queue: r.mq, Clock: r.clk,
		Stages:  &Stages{Graph: func(string) (*graph.Graph, error) { return g, nil }},
		OnError: func(err error) { t.Errorf("loop error: %v", err) }},
		Config{Reconcile: reconcile.Config{Tick: 30 * time.Second}, EventBuffer: 256})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func stagedRig(t *testing.T, workflow string) (*rig, *graph.Graph, map[string]api.Brief) {
	t.Helper()
	g, err := graph.ParseYAML("w", []byte(workflow))
	if err != nil {
		t.Fatal(err)
	}
	r := newRig(t, 2, meter.Budgets{}, tkt("5", 1))
	briefs := map[string]api.Brief{}
	r.c = restarted(t, r.tr, r, g, briefs)
	return r, g, briefs
}

// A restart does not send a ticket back to the first node: it resumes at the node it had reached, with the
// attempt count and pull request it had, and no session for an earlier node starts again.
func TestRestartResumesAtTheNodeReached(t *testing.T) {
	ctx := context.Background()
	t.Run("second node", func(t *testing.T) {
		r, g, briefs := stagedRig(t, twoNodeWorkflow)
		r.c.Tick(ctx)
		r.obs.Set(api.Observation{Ticket: "5", Attempt: 1, Branch: "factory/5-a1", HasReport: true, PR: 3, LastPush: t0})
		r.c.Tick(ctx) // plan is done: the ticket moves to build
		sessions := len(r.disp.Sessions)
		delete(r.obs.Obs, "5") // the build node has pushed nothing yet; the plan branch belongs to attempt 1

		c := restarted(t, r.tr, r, g, briefs)
		c.Tick(ctx)
		c.Tick(ctx)
		if st := c.stages["5"]; st == nil || st.node != "build" || st.base != 1 || st.pr != 3 {
			t.Fatalf("after the restart the position is %+v, want build, base 1, pr 3", st)
		}
		b, ok := briefs["5-a2"]
		if !ok || b.Node != "build" || b.Attempt != 2 {
			t.Fatalf("briefs %v: want the build node as attempt 2", briefs)
		}
		if got := len(r.disp.Sessions); got != sessions+1 {
			t.Fatalf("sessions %d -> %d: only the build node may start", sessions, got)
		}
		if _, again := r.disp.Sessions["5-a1"]; !again {
			t.Fatal("the plan session is gone")
		}
		for _, br := range briefs {
			if br.Attempt > 1 && br.Node == "plan" {
				t.Fatalf("the plan node ran again: %+v", br)
			}
		}
	})
	t.Run("parked on a human node", func(t *testing.T) {
		r, tt, briefs := parkedRig(t)
		sessions := slices.Sorted(mapKeys(r.disp.Sessions))
		g, _ := graph.ParseYAML("w", []byte(planWorkflow))
		tt2 := &parkedTracker{threadTracker: tt}
		r.c = restarted(t, tt2, r, g, briefs)
		r.c.Tick(ctx)
		st := r.c.stages["5"]
		if st == nil {
			t.Fatal("the parked ticket has no position after the restart")
		}
		if n, _ := st.g.Node(st.node); n.Kind != graph.KindHuman {
			t.Fatalf("position %+v: want the human node", st)
		}
		if st.base != 1 || st.pr != 3 {
			t.Fatalf("position %+v, want base 1 and pr 3", st)
		}
		// The restarted Core has a fresh store, so put back the interrupt a persistent one would still hold.
		r.c.raise(ctx, "5", st.node)
		tt2.comments = append(tt2.comments, gh.Comment{ID: 1, Author: "maintainer", Body: "/factory approve"})
		r.c.Tick(ctx)
		r.c.Tick(ctx)
		if got := slices.Sorted(mapKeys(r.disp.Sessions)); len(got) != len(sessions)+1 || briefs["5-a2"].Node != "build" {
			t.Fatalf("sessions %v -> %v, brief %+v: want only the build node to start", sessions, got, briefs["5-a2"])
		}
	})
}

// A node the edited workflow no longer has starts the ticket at the graph's first node, with one warning.
func TestRestartWithUnknownNodeStartsOver(t *testing.T) {
	ctx := context.Background()
	r, g, briefs := stagedRig(t, twoNodeWorkflow)
	r.tr.Position["5"] = observe.Position{V: 1, Node: "gone", Base: 4, PR: 3}
	c := restarted(t, r.tr, r, g, briefs)
	get := collect(t, c)
	c.Tick(ctx)
	if st := c.stages["5"]; st == nil || st.node != g.Start || st.base != 0 {
		t.Fatalf("position %+v, want the first node and base 0", st)
	}
	n := 0
	for _, ev := range get() {
		if ev.Kind == KindWarning && ev.Ticket == "5" {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("%d warning events, want 1", n)
	}
}

// parkedTracker lists the tickets waiting on a human, as the GitHub tracker does.
type parkedTracker struct{ *threadTracker }

func (p *parkedTracker) Parked(context.Context) ([]api.Ticket, error) {
	var out []api.Ticket
	for id, t := range p.Tickets {
		if p.Phases[id] == api.PhaseNeedsHuman {
			out = append(out, t)
		}
	}
	return out, nil
}

func mapKeys[M ~map[K]V, K comparable, V any](m M) func(func(K) bool) {
	return func(yield func(K) bool) {
		for k := range m {
			if !yield(k) {
				return
			}
		}
	}
}
