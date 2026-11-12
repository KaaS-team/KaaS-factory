package mergeq

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/gate"
	"github.com/KaaS-team/factory/internal/gitx"
)

// coreMergeQueue mirrors core.MergeQueue; mergeq cannot import internal/core (cycle).
type coreMergeQueue interface {
	Enqueue(ctx context.Context, id api.TicketID, pr int) error
	Queued(ctx context.Context) ([]Entry, error)
	Run(ctx context.Context) (Report, error)
}

var _ coreMergeQueue = (*CoreQueue)(nil)

// qtracker is porttest.Tracker plus the two reads CoreQueue needs, ordered by phase entry.
type qtracker struct {
	*porttest.Tracker
	mu    sync.Mutex
	order []api.TicketID // phase entry order, newest last
}

func (k *qtracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	k.mu.Lock()
	k.order = slices.DeleteFunc(k.order, func(x api.TicketID) bool { return x == id })
	k.order = append(k.order, id)
	k.mu.Unlock()
	return k.Tracker.SetPhase(ctx, id, p)
}

func (k *qtracker) InPhase(_ context.Context, p api.Phase) ([]api.TicketID, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	var out []api.TicketID
	for _, id := range k.order {
		if k.Phases[id] == p {
			out = append(out, id)
		}
	}
	return out, nil
}

func (k *qtracker) Comments(_ context.Context, id api.TicketID) ([]string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	return slices.Clone(k.Comments_(id)), nil
}

// Comments_ reads the fake's comment map.
func (k *qtracker) Comments_(id api.TicketID) []string { return k.Tracker.Comments[id] }

const qGate = `#!/bin/sh
if [ -e BROKEN ]; then
  echo "boom: BROKEN present"
  echo "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=broken"
else
  echo "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-"
fi
`

// repo is a bare origin, a queue clone and a worker clone.
type repo struct {
	t                   *testing.T
	root, origin, queue string
	merges              int
	gateLog             []string
}

func (r *repo) git(dir string, args ...string) string {
	r.t.Helper()
	c := exec.Command("git", args...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull,
		"GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
	out, err := c.CombinedOutput()
	if err != nil {
		r.t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func newRepo(t *testing.T) *repo {
	t.Helper()
	root := t.TempDir()
	r := &repo{t: t, root: root, origin: filepath.Join(root, "origin.git"), queue: filepath.Join(root, "queue")}
	r.git(root, "init", "-q", "--bare", "-b", "main", r.origin)
	work := filepath.Join(root, "work")
	r.git(root, "clone", "-q", r.origin, work)
	if err := os.WriteFile(filepath.Join(work, "gate.sh"), []byte(qGate), 0o755); err != nil {
		t.Fatal(err)
	}
	r.git(work, "add", "-A")
	r.git(work, "commit", "-q", "-m", "base")
	r.git(work, "push", "-q", "origin", "HEAD:refs/heads/main")
	r.git(root, "clone", "-q", r.origin, r.queue)
	return r
}

// branch pushes pr/<n> off main with one new file.
func (r *repo) branch(n int, file string) {
	r.t.Helper()
	work := filepath.Join(r.root, "work")
	r.git(work, "fetch", "-q", "origin")
	r.git(work, "checkout", "-q", "-B", fmt.Sprintf("pr%d", n), "origin/main")
	if err := os.WriteFile(filepath.Join(work, file), []byte("x\n"), 0o644); err != nil {
		r.t.Fatal(err)
	}
	r.git(work, "add", "-A")
	r.git(work, "commit", "-q", "-m", fmt.Sprintf("pr %d", n))
	r.git(work, "push", "-q", "origin", fmt.Sprintf("HEAD:refs/heads/pr/%d", n))
}

func (r *repo) main() string { return r.git(r.origin, "rev-parse", "refs/heads/main") }

type rGit struct{ r *repo }

func (g rGit) Base(ctx context.Context) (string, error) {
	return gitx.New(g.r.origin).RemoteRef(ctx, g.r.origin, "refs/heads/main")
}

func (g rGit) Merge(ctx context.Context, heads []string) (Merged, error) {
	r := g.r
	base, _ := g.Base(ctx)
	r.git(r.queue, "fetch", "-q", "origin")
	r.git(r.queue, "checkout", "-q", "--detach", base)
	for _, h := range heads {
		c := exec.Command("git", "merge", "--no-ff", "-q", "-m", "merge "+h, h)
		c.Dir = r.queue
		c.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
		if out, err := c.CombinedOutput(); err != nil {
			r.git(r.queue, "merge", "--abort")
			return Merged{}, fmt.Errorf("%w: %s", ErrConflict, out)
		}
	}
	r.merges++
	ref := fmt.Sprintf("refs/factory/merge/%d", r.merges)
	r.git(r.queue, "update-ref", ref, "HEAD")
	return Merged{Ref: ref, Base: base}, nil
}

func (g rGit) FastForward(ctx context.Context, ref string) error {
	sha := g.r.git(g.r.queue, "rev-parse", ref)
	err := gitx.New(g.r.queue).FFPush(ctx, "origin", sha, "main")
	if errors.Is(err, gitx.ErrNotFastForward) {
		return ErrBaseMoved
	}
	return err
}

type rGate struct{ r *repo }

func (g rGate) Run(ctx context.Context, ref string) (Verdict, error) {
	g.r.git(g.r.queue, "checkout", "-q", "--detach", ref)
	res := gate.Run(ctx, gate.Spec{Command: "sh ./gate.sh", Dir: g.r.queue})
	g.r.gateLog = append(g.r.gateLog, res.Status)
	return Verdict{Pass: res.Green(), LogTail: res.Raw}, nil
}

// rHeads reads pr/<n> heads from origin; a PR is open while its ticket is queued.
type rHeads struct {
	r *repo
	k *qtracker
	m map[int]api.TicketID
}

func (h rHeads) PR(ctx context.Context, pr int) (PRState, error) {
	head, err := gitx.New(h.r.origin).RemoteRef(ctx, h.r.origin, "refs/heads/pr/"+strconv.Itoa(pr))
	if err != nil {
		return PRState{}, err
	}
	p := h.k.Phases[h.m[pr]]
	return PRState{Head: head, Open: p == api.PhaseQueued, Merged: p == api.PhaseMerged}, nil
}

type rig struct {
	r *repo
	k *qtracker
	h rHeads
}

func newRig(t *testing.T, n int, broken ...int) *rig {
	t.Helper()
	r := newRepo(t)
	var ts []api.Ticket
	m := map[int]api.TicketID{}
	for i := 1; i <= n; i++ {
		id := api.TicketID("T" + strconv.Itoa(i))
		ts = append(ts, api.Ticket{ID: id})
		m[i] = id
		file := fmt.Sprintf("f%d", i)
		if slices.Contains(broken, i) {
			file = "BROKEN"
		}
		r.branch(i, file)
	}
	k := &qtracker{Tracker: porttest.NewTracker(ts...)}
	return &rig{r: r, k: k, h: rHeads{r: r, k: k, m: m}}
}

func (g *rig) queue() *CoreQueue {
	return NewCoreQueue(Deps{Tracker: g.k, Git: rGit{g.r}, Gate: rGate{g.r}, Heads: g.h, Cfg: Config{BatchSize: 4}})
}

func (g *rig) enqueue(t *testing.T, q *CoreQueue, ns ...int) {
	t.Helper()
	for _, n := range ns {
		if err := q.Enqueue(context.Background(), g.h.m[n], n); err != nil {
			t.Fatal(err)
		}
	}
}

func entryIDs(es []Entry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

// Symphony §7: a merged ticket leaves the claim states; here every landed ticket ends merged.
func TestCoreQueueGreenLandsInEnqueueOrder(t *testing.T) {
	g := newRig(t, 3)
	q := g.queue()
	g.enqueue(t, q, 2, 1, 3)
	rep, err := q.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"T2", "T1", "T3"}; !slices.Equal(rep.Landed, want) {
		t.Fatalf("landed %v, want %v", rep.Landed, want)
	}
	for _, id := range rep.Landed {
		if p := g.k.Phases[api.TicketID(id)]; p != api.PhaseMerged {
			t.Errorf("%s phase %s, want merged", id, p)
		}
	}
	log := g.r.git(g.r.origin, "log", "--first-parent", "--reverse", "--format=%s", "main")
	at := func(n int) int {
		return strings.Index(log, g.r.git(g.r.origin, "rev-parse", fmt.Sprintf("refs/heads/pr/%d", n)))
	}
	i2, i1, i3 := at(2), at(1), at(3)
	if i2 < 0 || i2 >= i1 || i1 >= i3 {
		t.Fatalf("main history not in enqueue order:\n%s", log)
	}
	if left, _ := q.Queued(context.Background()); len(left) != 0 {
		t.Fatalf("still queued: %v", left)
	}
}

func TestCoreQueueBrokenOneIsEjectedWithLogTail(t *testing.T) {
	g := newRig(t, 3, 2)
	q := g.queue()
	g.enqueue(t, q, 1, 2, 3)
	rep, err := q.Run(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"T1", "T3"}; !slices.Equal(rep.Landed, want) {
		t.Fatalf("landed %v, want %v", rep.Landed, want)
	}
	if len(rep.Ejected) != 1 || rep.Ejected[0].ID != "T2" || !strings.Contains(rep.Ejected[0].LogTail, "FACTORY_GATES: status=RED") {
		t.Fatalf("ejected %+v", rep.Ejected)
	}
	if p := g.k.Phases["T2"]; p != api.PhaseNeedsHuman {
		t.Fatalf("T2 phase %s", p)
	}
	if c := g.k.Tracker.Comments["T2"]; !strings.Contains(strings.Join(c, "\n"), "BROKEN present") && !strings.Contains(strings.Join(c, "\n"), "status=RED") {
		t.Fatalf("T2 comments lack the log tail: %v", c)
	}
	// main's gate is green after: check out main and run the gate.
	g.r.git(g.r.queue, "fetch", "-q", "origin")
	g.r.git(g.r.queue, "checkout", "-q", "--detach", g.r.main())
	if res := gate.Run(context.Background(), gate.Spec{Command: "sh ./gate.sh", Dir: g.r.queue}); !res.Green() {
		t.Fatalf("main gate: %+v", res)
	}
}

func TestCoreQueueRestartListsSameEntries(t *testing.T) {
	g := newRig(t, 3)
	q := g.queue()
	g.enqueue(t, q, 3, 1, 2)
	before, err := q.Queued(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	after, err := g.queue().Queued(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 3 || fmt.Sprint(before) != fmt.Sprint(after) {
		t.Fatalf("before %v after %v", before, after)
	}
	if want := []string{"T3", "T1", "T2"}; !slices.Equal(entryIDs(after), want) {
		t.Fatalf("order %v, want %v", entryIDs(after), want)
	}
	if after[0].Head != g.r.git(g.r.origin, "rev-parse", "refs/heads/pr/3") {
		t.Fatalf("head %q not the pr head", after[0].Head)
	}
}

func TestCoreQueueEnqueueTwiceIsNoOp(t *testing.T) {
	g := newRig(t, 2)
	q := g.queue()
	g.enqueue(t, q, 1, 2, 1)
	es, _ := q.Queued(context.Background())
	if want := []string{"T1", "T2"}; !slices.Equal(entryIDs(es), want) {
		t.Fatalf("queued %v, want %v", entryIDs(es), want)
	}
	if n := len(g.k.Tracker.Comments["T1"]); n != 1 {
		t.Fatalf("T1 has %d comments, want 1", n)
	}
}

func TestMarkerRoundTrip(t *testing.T) {
	for _, tc := range []struct {
		name, body string
		ok         bool
		pr         int
	}{
		{"plain", queuedMarker(7, "abc"), true, 7},
		{"embedded", "hello\n" + queuedMarker(9, "d") + "\nbye", true, 9},
		{"none", "no marker", false, 0},
		{"bad json", "<!-- factory:queued {nope} -->", false, 0},
		{"zero pr", `<!-- factory:queued {"pr":0,"head":"x"} -->`, false, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, ok := parseQueuedMarker(tc.body)
			if ok != tc.ok || m.PR != tc.pr {
				t.Fatalf("got %+v %v", m, ok)
			}
		})
	}
}

func TestCoreQueueStoreBranches(t *testing.T) {
	g := newRig(t, 1)
	q := g.queue()
	g.enqueue(t, q, 1)
	s := coreStore{q}
	ctx := context.Background()
	if err := s.Requeue(ctx, "T1", "newhead"); err != nil {
		t.Fatal(err)
	}
	es, _ := q.Queued(ctx)
	if len(es) != 1 || es[0].Head != "newhead" {
		t.Fatalf("after requeue %v", es)
	}
	for reason, want := range map[string]api.Phase{ReasonClosed: api.PhaseCanceled, ReasonMerged: api.PhaseMerged} {
		g.k.Phases["T1"] = api.PhaseQueued
		if err := s.Drop(ctx, "T1", reason); err != nil {
			t.Fatal(err)
		}
		if p := g.k.Phases["T1"]; p != want {
			t.Errorf("drop %s -> %s, want %s", reason, p, want)
		}
	}
}
