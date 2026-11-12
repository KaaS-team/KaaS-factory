// Package e2e runs the whole v9 loop in one test: tickets in a fake tracker, a fake dispatcher that
// pushes branches into a real local git repo, the merge queue gating with the repo's gates.sh, and
// main green at the end. It composes the packages directly and does not use internal/core.
package e2e

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/gate"
	"github.com/KaaS-team/factory/internal/pick"
)

// solutions scripts what each fake session commits. t2 breaks the build on purpose.
var solutions = map[api.TicketID]func(*testing.T, string){
	"t1": func(t *testing.T, dir string) {
		addFunc(t, dir, "a.go", "func A() int { return 10 }\n")
		addFunc(t, dir, "a_test.go", "func TestA(t *testing.T) {\n\tif A() != 10 {\n\t\tt.Fatal(\"A\")\n\t}\n}\n")
	},
	"t2": func(t *testing.T, dir string) {
		addFunc(t, dir, "b.go", "func B() int { return missingSymbol }\n")
	},
	"t3": func(t *testing.T, dir string) {
		addFunc(t, dir, "shared.go", "func Double(n int) int { return n * 2 }\n")
		addFunc(t, dir, "shared_test.go", "func TestDouble(t *testing.T) {\n\tif Double(2) != 4 {\n\t\tt.Fatal(\"Double\")\n\t}\n}\n")
	},
	"t4": func(t *testing.T, dir string) {
		addFunc(t, dir, "shared.go", "func Triple(n int) int { return n * 3 }\n")
		addFunc(t, dir, "shared_test.go", "func TestTriple(t *testing.T) {\n\tif Triple(2) != 6 {\n\t\tt.Fatal(\"Triple\")\n\t}\n}\n")
	},
	"t5": func(t *testing.T, dir string) {
		addFunc(t, dir, "e.go", "func E() int { return 5 }\n")
		addFunc(t, dir, "e_test.go", "func TestE(t *testing.T) {\n\tif E() != 5 {\n\t\tt.Fatal(\"E\")\n\t}\n}\n")
	},
}

// scenario is five tickets: t3 and t4 declare the same file, t2 is the broken one.
func scenario() []api.Ticket {
	at := time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)
	mk := func(i int, id, file string) api.Ticket {
		return api.Ticket{
			ID: api.TicketID(id), Repo: "example/tiny", Title: "solve " + id, Files: []string{file},
			CreatedAt: at.Add(time.Duration(i) * time.Minute),
		}
	}
	return []api.Ticket{mk(1, "t1", "a.go"), mk(2, "t2", "b.go"), mk(3, "t3", "shared.go"), mk(4, "t4", "shared.go"), mk(5, "t5", "e.go")}
}

// outcome is the final state a run is judged by.
type outcome struct {
	w      *world
	steps  int
	took   time.Duration
	phases map[api.TicketID]api.Phase
	tree   string
}

func runScenario(t *testing.T, restartAt int) outcome {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	start := time.Now()
	w := newWorld(t, ctx, scenario())
	steps := w.run(restartAt)
	o := outcome{w: w, steps: steps, took: time.Since(start), phases: map[api.TicketID]api.Phase{}}
	for id, p := range w.trk.Phases {
		o.phases[id] = p
	}
	o.tree = w.git(w.origin, "rev-parse", "main^{tree}")
	return o
}

// mainGate runs the repo's gate on a fresh clone of main.
func mainGate(t *testing.T, w *world) gate.Result {
	t.Helper()
	dir := t.TempDir() + "/final"
	w.git(w.root, "clone", "-q", w.origin, dir)
	return gate.Run(w.ctx, gate.Spec{Command: "sh ./gates.sh", Dir: dir, Timeout: 60 * time.Second, Env: []string{"GOPROXY=off", "CGO_ENABLED=0"}})
}

// TestFiveTicketsTwoSlotsBisectTheBroken covers Symphony 8.3 (slots), 7.4 (completion read from
// git) and the merge queue bisect: four tickets merge, the broken one goes to needs-human with the
// gate log, and main's gate passes at the end.
func TestFiveTicketsTwoSlotsBisectTheBroken(t *testing.T) {
	o := runScenario(t, 0)
	w := o.w
	if o.took >= 30*time.Second {
		t.Errorf("run took %s, the budget is 30s", o.took)
	}
	want := map[api.TicketID]api.Phase{"t1": api.PhaseMerged, "t2": api.PhaseNeedsHuman, "t3": api.PhaseMerged, "t4": api.PhaseMerged, "t5": api.PhaseMerged}
	for id, p := range want {
		if o.phases[id] != p {
			t.Errorf("%s: phase %q, want %q", id, o.phases[id], p)
		}
	}

	if len(w.rep.Ejected) != 1 || w.rep.Ejected[0].ID != "t2" {
		t.Fatalf("ejected %+v, want only t2", w.rep.Ejected)
	}
	comments := w.trk.Comments["t2"]
	if len(comments) != 1 || !strings.Contains(comments[0], "FACTORY_GATES: status=RED") || !strings.Contains(comments[0], "missingSymbol") {
		t.Errorf("t2 needs-human comment lacks the gate log: %q", comments)
	}

	// The bisect: t1 and t2 are tested together (red), then t1 alone (green, lands), then t2 alone (red).
	got := gateEvents(w.events)
	wantGates := []string{"gate t1,t2 RED", "gate t1 GREEN", "gate t2 RED", "gate t3,t5 GREEN", "gate t4 GREEN"}
	if strings.Join(got, "|") != strings.Join(wantGates, "|") {
		t.Errorf("gate runs\n got %v\nwant %v", got, wantGates)
	}

	g := mainGate(t, w)
	if !g.Green() || g.Passed != 1 {
		t.Errorf("main gate: %+v", g)
	}
	for _, f := range []string{"a.go", "e.go", "shared.go"} {
		if _, err := w.gitTry(w.origin, "cat-file", "-e", "main:"+f); err != nil {
			t.Errorf("main lacks %s", f)
		}
	}
	if _, err := w.gitTry(w.origin, "cat-file", "-e", "main:b.go"); err == nil {
		t.Error("main holds the broken b.go")
	}
	shared := w.git(w.origin, "show", "main:shared.go")
	if !strings.Contains(shared, "Double") || !strings.Contains(shared, "Triple") {
		t.Errorf("shared.go lost a ticket's change:\n%s", shared)
	}
}

func gateEvents(events []string) []string {
	var out []string
	for _, e := range events {
		if strings.HasPrefix(e, "gate ") {
			out = append(out, e)
		}
	}
	return out
}

// span is the event index range a ticket held a slot (dispatch to done) or its files (dispatch to merged or needs-human).
type span struct{ start, slotEnd, fileEnd int }

func spans(events []string) map[api.TicketID]*span {
	out := map[api.TicketID]*span{}
	for i, e := range events {
		f := strings.Fields(e)
		if len(f) < 2 {
			continue
		}
		id := api.TicketID(f[1])
		switch {
		case f[0] == "dispatch":
			out[id] = &span{start: i, slotEnd: -1, fileEnd: -1}
		case f[0] == "phase" && out[id] != nil && len(f) == 3:
			switch api.Phase(f[2]) {
			case api.PhaseDone:
				out[id].slotEnd = i
			case api.PhaseMerged, api.PhaseNeedsHuman:
				out[id].fileEnd = i
			}
		}
	}
	return out
}

// TestOverlappingFilesNeverRunTogether covers Symphony 8.2 and 8.3: two tickets whose Files overlap
// are never in flight at once (from dispatch until the work is merged), and no more than two run.
func TestOverlappingFilesNeverRunTogether(t *testing.T) {
	o := runScenario(t, 0)
	tickets := scenario()
	sp := spans(o.w.events)
	overlapping := 0
	for i, a := range tickets {
		for _, b := range tickets[i+1:] {
			if !pick.Overlap(a.Files, b.Files) {
				continue
			}
			overlapping++
			x, y := sp[a.ID], sp[b.ID]
			if x.fileEnd < 0 || y.fileEnd < 0 {
				t.Fatalf("%s or %s never finished: %v %v", a.ID, b.ID, x, y)
			}
			if x.start < y.start && y.start < x.fileEnd || y.start < x.start && x.start < y.fileEnd {
				t.Errorf("%s and %s share files but were in flight together: %+v %+v\n%v", a.ID, b.ID, x, y, o.w.events)
			}
		}
	}
	if overlapping != 1 {
		t.Fatalf("scenario has %d overlapping pairs, want 1", overlapping)
	}
	// The lock must matter: t4 had a free slot before t3 merged.
	if sp["t3"].slotEnd >= sp["t4"].start && sp["t4"].slotEnd >= sp["t3"].start {
		t.Skip("scenario no longer frees a slot while the overlapping ticket waits to merge")
	}
	for i := range o.w.events {
		inSlot := 0
		for _, s := range sp {
			if s.start <= i && (s.slotEnd < 0 || i < s.slotEnd) {
				inSlot++
			}
		}
		if inSlot > 2 {
			t.Fatalf("%d tickets held a slot at event %d: %v", inSlot, i, o.w.events)
		}
	}
}

// TestStoreRebuildMidRunEndsInTheSameState covers Symphony 14.3 and 7.4: killing the store file and
// the in-memory state at a step, then rebuilding from git and the tracker, ends where an
// uninterrupted run ends. Restarts land before a first observe (2), with a queue waiting while a
// ticket waits for its overlapping predecessor to merge (6), and with the last ticket queued (9). A
// restart step runs two ticks (recover, then act), so it may finish in fewer steps; only the final
// state is compared.
func TestStoreRebuildMidRunEndsInTheSameState(t *testing.T) {
	base := runScenario(t, 0)
	for _, tc := range []struct {
		name      string
		restartAt int
		compares  bool // some live store rows existed to compare with the rebuilt ones
	}{
		{"after first dispatch", 2, false},
		{"queue waiting, file lock held", 6, true},
		{"last ticket queued", 9, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			o := runScenario(t, tc.restartAt)
			for id, p := range base.phases {
				if o.phases[id] != p {
					t.Errorf("%s: phase %q after restart, uninterrupted run gave %q", id, o.phases[id], p)
				}
			}
			if o.tree != base.tree {
				t.Errorf("main tree %s after restart, uninterrupted run gave %s", o.tree, base.tree)
			}
			if a, b := o.w.trk.Comments["t2"], base.w.trk.Comments["t2"]; strings.Join(a, "|") != strings.Join(b, "|") {
				t.Errorf("t2 comment differs after restart:\n%q\n%q", a, b)
			}
			if tc.compares && o.w.rebuildCompared == 0 {
				t.Error("the rebuild was compared with no live rows")
			}
			if !mainGate(t, o.w).Green() {
				t.Error("main gate is red after the restart run")
			}
		})
	}
}
