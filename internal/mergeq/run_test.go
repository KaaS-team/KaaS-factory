package mergeq

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand"
	"slices"
	"strings"
	"testing"
)

// world is an in-memory repo, gate and tracker. A commit is the set of PRs it contains; a PR is bad
// when the gate fails on any commit containing it.
type world struct {
	bad       map[string]bool
	heads     map[string]string // PR id -> current head
	queued    map[string]string // PR id -> head recorded when queued
	queue     []string          // PR ids in order
	closed    map[string]bool
	base      string
	baseSet   map[string]bool
	baseN     int
	refs      map[string]refInfo
	gated     map[string]bool // ref -> gate result
	gateRuns  int
	ffs       []string   // refs fast-forwarded to, in order
	ffPRs     [][]string // PRs newly in each fast-forward
	onGate    func()     // test hook run after each gate
	ejected   []Ejection
	mergeFail map[string]bool // head -> conflicts when merged
}

type refInfo struct {
	base string
	set  map[string]bool
	new  []string
}

func newWorld(n int, bad ...int) *world {
	w := &world{bad: map[string]bool{}, heads: map[string]string{}, queued: map[string]string{}, closed: map[string]bool{},
		base: "B0", baseSet: map[string]bool{}, refs: map[string]refInfo{}, gated: map[string]bool{}, mergeFail: map[string]bool{}}
	for i := 1; i <= n; i++ {
		id := fmt.Sprint(i)
		w.heads[id] = "h" + id
		w.queued[id] = "h" + id
		w.queue = append(w.queue, id)
	}
	for _, b := range bad {
		w.bad[fmt.Sprint(b)] = true
	}
	return w
}

func (w *world) idOf(head string) string {
	return strings.TrimRight(strings.TrimPrefix(head, "h"), "b")
}

func (w *world) Base(context.Context) (string, error) { return w.base, nil }

func (w *world) Merge(_ context.Context, heads []string) (Merged, error) {
	set := map[string]bool{}
	for k := range w.baseSet {
		set[k] = true
	}
	var fresh []string
	for _, h := range heads {
		if w.mergeFail[h] {
			return Merged{}, fmt.Errorf("%w: %s", ErrConflict, h)
		}
		id := w.idOf(h)
		if !set[id] {
			fresh = append(fresh, id)
		}
		set[id] = true
	}
	ref := fmt.Sprintf("tmp/%d", len(w.refs))
	w.refs[ref] = refInfo{base: w.base, set: set, new: fresh}
	return Merged{Ref: ref, Base: w.base}, nil
}

func (w *world) Run(_ context.Context, ref string) (Verdict, error) {
	w.gateRuns++
	info := w.refs[ref]
	pass, tail := true, "ok"
	for id := range info.set {
		if w.bad[id] {
			pass, tail = false, "FAIL pr"+id
		}
	}
	w.gated[ref] = pass
	if w.onGate != nil {
		w.onGate()
	}
	return Verdict{Pass: pass, LogTail: tail}, nil
}

func (w *world) FastForward(_ context.Context, ref string) error {
	info := w.refs[ref]
	if info.base != w.base {
		return ErrBaseMoved
	}
	w.ffs = append(w.ffs, ref)
	w.ffPRs = append(w.ffPRs, info.new)
	w.baseSet = info.set
	w.baseN++
	w.base = fmt.Sprintf("B%d", w.baseN)
	return nil
}

func (w *world) Queued(context.Context) ([]Entry, error) {
	var out []Entry
	for _, id := range w.queue {
		out = append(out, Entry{ID: id, Head: w.queued[id]})
	}
	return out, nil
}

func (w *world) PR(_ context.Context, id string) (PRState, error) {
	return PRState{Head: w.heads[id], Open: !w.closed[id], Merged: w.baseSet[id]}, nil
}

func (w *world) remove(id string) {
	w.queue = slices.DeleteFunc(w.queue, func(s string) bool { return s == id })
}

func (w *world) Landed(_ context.Context, ids []string) error {
	for _, id := range ids {
		w.remove(id)
	}
	return nil
}

func (w *world) Eject(_ context.Context, id, log string) error {
	w.ejected = append(w.ejected, Ejection{ID: id, LogTail: log})
	w.remove(id)
	return nil
}

func (w *world) Drop(_ context.Context, id, _ string) error { w.remove(id); return nil }

func (w *world) Requeue(_ context.Context, id, head string) error { w.queued[id] = head; return nil }

func (w *world) runner(batch int) *Runner {
	return &Runner{Git: w, Gate: w, Store: w, Cfg: Config{BatchSize: batch}}
}

func landedOrder(w *world) []string {
	var out []string
	for _, p := range w.ffPRs {
		out = append(out, p...)
	}
	return out
}

func TestRunGreenBatchIsOneFastForward(t *testing.T) {
	w := newWorld(4)
	rep, err := w.runner(4).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(w.ffs) != 1 || w.gateRuns != 1 || !slices.Equal(rep.Landed, []string{"1", "2", "3", "4"}) {
		t.Fatalf("ffs=%d gateRuns=%d landed=%v", len(w.ffs), w.gateRuns, rep.Landed)
	}
}

// Acceptance: PR 3 of 8 breaks the gate; the other 7 land in order, 3 is ejected with its log tail,
// and the bisect costs at most ceil(log2 8)+1 gate runs beyond the first batch run.
func TestRunBisectsToTheCulprit(t *testing.T) {
	w := newWorld(8, 3)
	rep, err := w.runner(8).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"1", "2", "4", "5", "6", "7", "8"}; !slices.Equal(landedOrder(w), want) {
		t.Fatalf("landed %v want %v", landedOrder(w), want)
	}
	if len(rep.Ejected) != 1 || rep.Ejected[0] != (Ejection{ID: "3", LogTail: "FAIL pr3"}) {
		t.Fatalf("ejected %+v", rep.Ejected)
	}
	extra := w.gateRuns - 1
	if limit := int(math.Ceil(math.Log2(8))) + 1; extra > limit {
		t.Fatalf("%d extra gate runs, limit %d", extra, limit)
	}
	if len(w.queue) != 0 || w.bad["3"] && w.baseSet["3"] {
		t.Fatalf("queue=%v", w.queue)
	}
}

func TestRunMergeConflictEjectsThePR(t *testing.T) {
	w := newWorld(3)
	w.mergeFail["h2"] = true
	rep, err := w.runner(4).Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(rep.Ejected) != 1 || rep.Ejected[0].ID != "2" || !strings.Contains(rep.Ejected[0].LogTail, "conflict") {
		t.Fatalf("ejected %+v", rep.Ejected)
	}
	if !slices.Equal(landedOrder(w), []string{"1", "3"}) {
		t.Fatalf("landed %v", landedOrder(w))
	}
}

func TestRunDropsClosedAndRetestsMovedHead(t *testing.T) {
	w := newWorld(3)
	w.closed["1"] = true
	moved := false
	w.onGate = func() { // PR 2 gets a new head while its first batch is being tested
		if !moved {
			moved = true
			w.heads["2"] = "h2b"
		}
	}
	r := w.runner(4)
	rep, err := r.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(rep.Dropped, []string{"1"}) {
		t.Fatalf("dropped %v", rep.Dropped)
	}
	if w.gateRuns < 2 {
		t.Fatalf("moved head must be retested, gate ran %d times", w.gateRuns)
	}
	for _, ref := range w.ffs {
		if !w.gated[ref] {
			t.Fatalf("fast-forwarded to ungated ref %s", ref)
		}
	}
	if !slices.Equal(landedOrder(w), []string{"2", "3"}) {
		t.Fatalf("landed %v", landedOrder(w))
	}
	if w.queued["2"] != "h2b" {
		t.Fatalf("head not requeued: %v", w.queued)
	}
}

// Acceptance: over random green/red assignments, the base only advances to a ref whose gate passed
// and no bad PR ever lands.
func TestPropertyBaseNeverRed(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	for i := 0; i < 300; i++ {
		n := 1 + rng.Intn(12)
		var bad []int
		for p := 1; p <= n; p++ {
			if rng.Intn(4) == 0 {
				bad = append(bad, p)
			}
		}
		w := newWorld(n, bad...)
		if _, err := w.runner(1 + rng.Intn(6)).Run(context.Background()); err != nil {
			t.Fatal(err)
		}
		for _, ref := range w.ffs {
			if !w.gated[ref] {
				t.Fatalf("case %d: base advanced to ungated or red ref %s", i, ref)
			}
		}
		for id := range w.baseSet {
			if w.bad[id] {
				t.Fatalf("case %d: bad PR %s reached base", i, id)
			}
		}
		if len(w.queue) != 0 {
			t.Fatalf("case %d: queue not drained: %v", i, w.queue)
		}
		if len(w.baseSet)+len(w.ejected) != n {
			t.Fatalf("case %d: %d landed + %d ejected != %d", i, len(w.baseSet), len(w.ejected), n)
		}
	}
}

// Acceptance: a new Run built from the same tracker state continues without merging a PR twice,
// including a crash after the fast-forward and before the tracker was told.
func TestRestartNeverMergesTwice(t *testing.T) {
	for _, crashAfterFF := range []bool{false, true} {
		t.Run(fmt.Sprintf("crashAfterFF=%v", crashAfterFF), func(t *testing.T) {
			w := newWorld(6, 5)
			ctx, cancel := context.WithCancel(context.Background())
			var store Store = w
			if crashAfterFF {
				store = &failLanded{Store: w}
			}
			first := &Runner{Git: w, Gate: w, Store: store, Cfg: Config{BatchSize: 3}}
			w.onGate = func() {
				if !crashAfterFF && w.gateRuns == 2 {
					cancel()
				}
			}
			if _, err := first.Run(ctx); err == nil {
				t.Fatal("first run should have been interrupted")
			}
			w.onGate = nil
			if _, err := w.runner(3).Run(context.Background()); err != nil {
				t.Fatal(err)
			}
			seen := map[string]int{}
			for _, id := range landedOrder(w) {
				seen[id]++
			}
			for id, c := range seen {
				if c != 1 {
					t.Fatalf("PR %s merged %d times", id, c)
				}
			}
			if len(seen) != 5 || seen["5"] != 0 || len(w.queue) != 0 {
				t.Fatalf("landed %v queue %v", seen, w.queue)
			}
		})
	}
}

type failLanded struct{ Store }

func (f *failLanded) Landed(context.Context, []string) error { return errors.New("crash") }

func TestRunStopsOnGitError(t *testing.T) {
	w := newWorld(1)
	r := w.runner(4)
	r.Git = badGit{w}
	if _, err := r.Run(context.Background()); err == nil {
		t.Fatal("want error")
	}
}

type badGit struct{ *world }

func (badGit) Base(context.Context) (string, error) { return "", errors.New("boom") }

// A head that moves between the plan and the fast-forward must not land on the old green result.
func TestRunRechecksHeadsBeforeLanding(t *testing.T) {
	w := newWorld(1)
	s := &movingStore{world: w, moveOn: 3}
	r := &Runner{Git: w, Gate: w, Store: s, Cfg: Config{BatchSize: 4}}
	if _, err := r.Run(context.Background()); err != nil {
		t.Fatal(err)
	}
	if w.gateRuns != 2 {
		t.Fatalf("want a second gate run for the moved head, got %d", w.gateRuns)
	}
	if w.queued["1"] != "h1b" {
		t.Fatalf("head not requeued: %v", w.queued)
	}
}

type movingStore struct {
	*world
	calls, moveOn int
}

func (m *movingStore) PR(ctx context.Context, id string) (PRState, error) {
	m.calls++
	if m.calls == m.moveOn {
		m.heads[id] = "h1b"
	}
	return m.world.PR(ctx, id)
}
