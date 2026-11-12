package e2e

// The world the loop runs in: a real local git repo with a tiny Go module, a fake tracker and a
// fake dispatcher, and thin adapters that let internal/mergeq, internal/gate, internal/observe and
// internal/store run against them. Nothing here imports internal/core.

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/gate"
	"github.com/KaaS-team/factory/internal/gitx"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/pick"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
)

const gatesScript = `#!/bin/sh
# Runs go test, then prints one FACTORY_GATES line; the runner keeps the output tail.
if go test ./... 2>&1; then
  echo "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-"
else
  echo "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=go-test"
fi
`

// clock is the fake clock every component reads.
type clock struct{ t time.Time }

func (c *clock) Now() time.Time          { return c.t }
func (c *clock) Advance(d time.Duration) { c.t = c.t.Add(d) }

// world holds the repos, the fakes and the loop state.
type world struct {
	t      *testing.T
	ctx    context.Context
	clk    *clock
	events []string

	root, origin, agent, queue string
	originGit                  gitx.Git

	trk   *tracker
	disp  *dispatcher
	raw   *rawObserver
	store *store.Store
	spath string

	state *reconcile.State
	merge int // temp ref counter
	rep   mergeq.Report

	rebuildCompared int // tickets whose rebuilt rows were compared with live rows at the last restart
}

func newWorld(t *testing.T, ctx context.Context, tickets []api.Ticket) *world {
	t.Helper()
	for _, bin := range []string{"git", "go", "sh"} {
		if _, err := exec.LookPath(bin); err != nil {
			t.Fatalf("the harness needs %s on PATH: %v", bin, err)
		}
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_SYSTEM", os.DevNull)
	root := t.TempDir()
	w := &world{
		t: t, ctx: ctx, clk: &clock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		root: root, origin: filepath.Join(root, "origin.git"), agent: filepath.Join(root, "agent"), queue: filepath.Join(root, "queue"),
		spath: filepath.Join(root, "factory.db"),
	}
	w.originGit = gitx.New(w.origin)
	w.git(root, "init", "-q", "--bare", "-b", "main", w.origin)
	w.git(root, "clone", "-q", w.origin, w.agent)
	put(w.t, w.agent, "go.mod", "module example.com/tiny\n\ngo 1.20\n")
	put(w.t, w.agent, "gates.sh", gatesScript)
	if err := os.Chmod(filepath.Join(w.agent, "gates.sh"), 0o755); err != nil {
		t.Fatal(err)
	}
	put(w.t, w.agent, "base.go", "package tiny\n\nfunc Base() int { return 1 }\n")
	put(w.t, w.agent, "base_test.go", "package tiny\n\nimport \"testing\"\n\nfunc TestBase(t *testing.T) {\n\tif Base() != 1 {\n\t\tt.Fatal(\"Base\")\n\t}\n}\n")
	w.git(w.agent, "add", "-A")
	w.git(w.agent, "commit", "-q", "-m", "tiny module")
	w.git(w.agent, "push", "-q", "origin", "HEAD:refs/heads/main")
	w.git(root, "clone", "-q", w.origin, w.queue)

	w.trk = &tracker{Tracker: porttest.NewTracker(tickets...), w: w}
	w.disp = &dispatcher{Dispatcher: porttest.NewDispatcher(2), w: w, jobs: map[string]*job{}}
	w.raw = &rawObserver{w: w, inner: observe.New(source{w})}
	w.openStore()
	return w
}

func (w *world) openStore() {
	s, err := store.Open(w.spath)
	if err != nil {
		w.t.Fatal(err)
	}
	w.store = s
	w.t.Cleanup(func() { _ = s.Close() })
}

func (w *world) logf(format string, args ...any) {
	w.events = append(w.events, fmt.Sprintf(format, args...))
}

// gitTry runs git with the fake clock as author and committer date.
func (w *world) gitTry(dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(w.ctx, "git", args...)
	cmd.Dir = dir
	d := w.clk.Now().Format(time.RFC3339)
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=agent", "GIT_AUTHOR_EMAIL=agent@example.com",
		"GIT_COMMITTER_NAME=agent", "GIT_COMMITTER_EMAIL=agent@example.com",
		"GIT_AUTHOR_DATE="+d, "GIT_COMMITTER_DATE="+d, "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

func (w *world) git(dir string, args ...string) string {
	w.t.Helper()
	out, err := w.gitTry(dir, args...)
	if err != nil {
		w.t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return out
}

func put(t *testing.T, dir, name, content string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

// addFunc appends body to a Go file, creating it with a package header when it is new.
func addFunc(t *testing.T, dir, name, body string) {
	t.Helper()
	p := filepath.Join(dir, name)
	head := ""
	if _, err := os.Stat(p); errors.Is(err, os.ErrNotExist) {
		head = "package tiny\n"
		if strings.HasSuffix(name, "_test.go") {
			head += "\nimport \"testing\"\n"
		}
	}
	f, err := os.OpenFile(p, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.WriteString(head + "\n" + body); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
}

// tracker is porttest.Tracker with the read semantics a real tracker has: Ready lists every ticket
// the factory still owns, not only the unclaimed ones, and Active lists claimed work not finished.
type tracker struct {
	*porttest.Tracker
	w      *world
	queue  []api.TicketID // merge queue order
	freeze bool           // hide unclaimed tickets (restart tick only)
}

func (k *tracker) tickets(phases ...api.Phase) []api.Ticket {
	var out []api.Ticket
	for id, t := range k.Tickets {
		for _, p := range phases {
			if k.Phases[id] == p {
				out = append(out, t)
			}
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

func (k *tracker) Ready(context.Context) ([]api.Ticket, error) {
	owned := []api.Phase{api.PhaseClaimed, api.PhaseRunning, api.PhaseStalled, api.PhaseRetryQueue}
	if !k.freeze {
		owned = append(owned, api.PhaseReady)
	}
	return k.tickets(owned...), nil
}

func (k *tracker) Active(context.Context) ([]api.Ticket, error) {
	return k.tickets(api.PhaseClaimed, api.PhaseRunning, api.PhaseStalled, api.PhaseRetryQueue, api.PhaseDone, api.PhaseQueued), nil
}

func (k *tracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	k.w.logf("phase %s %s", id, p)
	return k.Tracker.SetPhase(ctx, id, p)
}

// enqueue moves every done ticket into the merge queue, in id order.
func (k *tracker) enqueue(ctx context.Context) error {
	for _, t := range k.tickets(api.PhaseDone) {
		k.queue = append(k.queue, t.ID)
		if err := k.SetPhase(ctx, t.ID, api.PhaseQueued); err != nil {
			return err
		}
	}
	return nil
}

func (k *tracker) finished() bool {
	for id := range k.Tickets {
		switch k.Phases[id] {
		case api.PhaseMerged, api.PhaseNeedsHuman, api.PhaseCanceled:
		default:
			return false
		}
	}
	return true
}

// heldFiles are the files of tickets that left their slot but are not merged yet.
func (k *tracker) heldFiles() []string {
	var out []string
	for _, t := range k.tickets(api.PhaseDone, api.PhaseQueued) {
		out = append(out, t.Files...)
	}
	return out
}

// job is the commit a fake session made, waiting to be pushed on the next observe.
type job struct {
	branch string
	sha    string
	pushed bool
	pr     int
}

// dispatcher is the fake that "runs" a session: on Dispatch it commits the scripted solution on
// factory/<t>-a<n> in the agent clone, and the push happens on the next observe.
type dispatcher struct {
	*porttest.Dispatcher
	w    *world
	jobs map[string]*job
	prs  int
}

func (d *dispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	key := fmt.Sprintf("%s-a%d", b.Ticket, b.Attempt)
	if _, ok := d.jobs[key]; !ok {
		w := d.w
		w.logf("dispatch %s", b.Ticket)
		w.git(w.agent, "fetch", "-q", "origin")
		w.git(w.agent, "checkout", "-q", "-B", b.Branch, "origin/main")
		solutions[b.Ticket](w.t, w.agent)
		w.git(w.agent, "add", "-A")
		w.git(w.agent, "commit", "-q", "-m", string(b.Ticket)+": "+b.Text)
		d.jobs[key] = &job{branch: b.Branch, sha: w.git(w.agent, "rev-parse", "HEAD")}
	}
	return d.Dispatcher.Dispatch(ctx, b)
}

// flush pushes the work branch and the report branch for one attempt, once.
func (d *dispatcher) flush(ctx context.Context, id api.TicketID, attempt int) error {
	j, ok := d.jobs[fmt.Sprintf("%s-a%d", id, attempt)]
	if !ok || j.pushed {
		return nil
	}
	g := gitx.New(d.w.agent)
	for _, br := range []string{j.branch, observe.ReportBranch(id)} {
		if err := g.FFPush(ctx, "origin", j.sha, br); err != nil {
			return err
		}
	}
	d.prs++
	j.pushed, j.pr = true, d.prs
	d.w.logf("push %s", id)
	return nil
}

func (d *dispatcher) latest(id api.TicketID) *job {
	var best *job
	for n := 1; n <= 20; n++ {
		if j, ok := d.jobs[fmt.Sprintf("%s-a%d", id, n)]; ok {
			best = j
		}
	}
	return best
}

// source is the observe.Source over the bare origin repo and the tracker's phases.
type source struct{ w *world }

func (s source) Branch(ctx context.Context, name string) (time.Time, bool, error) {
	sha, err := s.w.originGit.RemoteRef(ctx, s.w.origin, "refs/heads/"+name)
	if err != nil || sha == "" {
		return time.Time{}, false, err
	}
	out, err := s.w.gitTry(s.w.origin, "log", "-1", "--format=%ct", sha)
	if err != nil {
		return time.Time{}, false, fmt.Errorf("log %s: %w", name, err)
	}
	sec, err := strconv.ParseInt(out, 10, 64)
	return time.Unix(sec, 0).UTC(), true, err
}

func ticketOfBranch(head string) api.TicketID {
	s := strings.TrimPrefix(head, "factory/")
	if i := strings.LastIndex(s, "-a"); i > 0 {
		s = s[:i]
	}
	return api.TicketID(s)
}

func (s source) PullRequest(_ context.Context, head string) (observe.PR, bool, error) {
	id := ticketOfBranch(head)
	j := s.w.disp.latest(id)
	if j == nil || !j.pushed {
		return observe.PR{}, false, nil
	}
	switch s.w.trk.Phases[id] {
	case api.PhaseMerged, api.PhaseNeedsHuman, api.PhaseCanceled:
		return observe.PR{Number: j.pr}, true, nil
	}
	return observe.PR{Number: j.pr, Open: true}, true, nil
}

func (source) Checks(context.Context, int) (observe.Checks, error) { return observe.ChecksNone, nil }

func (s source) DiffFiles(ctx context.Context, branch string) ([]string, error) {
	return s.w.originGit.DiffNames(ctx, "main", branch)
}

// rawObserver lets the fake session push first, then reads git through observe.Observer.
type rawObserver struct {
	w     *world
	inner *observe.Observer
}

func (o *rawObserver) Observe(ctx context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	if err := o.w.disp.flush(ctx, id, attempt); err != nil {
		return api.Observation{}, err
	}
	return o.inner.Observe(ctx, id, attempt)
}

// recordingObserver is what reconcile sees: every observation of a pushed branch also lands in the
// live store, the way the core is expected to feed it between rebuilds.
type recordingObserver struct{ w *world }

func (o recordingObserver) Observe(ctx context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	obs, err := o.w.raw.Observe(ctx, id, attempt)
	if err != nil || obs.Branch == "" {
		return obs, err
	}
	if err := o.w.store.PutTicket(ctx, o.w.trk.Tickets[id]); err != nil {
		return obs, err
	}
	return obs, o.w.store.Apply(ctx, obs)
}

// queueGit implements mergeq.Git on the queue clone.
type queueGit struct{ w *world }

func (g queueGit) Base(ctx context.Context) (string, error) {
	return g.w.originGit.RemoteRef(ctx, g.w.origin, "refs/heads/main")
}

func (g queueGit) Merge(ctx context.Context, heads []string) (mergeq.Merged, error) {
	w := g.w
	base, err := g.Base(ctx)
	if err != nil {
		return mergeq.Merged{}, err
	}
	w.git(w.queue, "fetch", "-q", "origin")
	w.git(w.queue, "checkout", "-q", "--detach", base)
	for _, h := range heads {
		if out, err := w.gitTry(w.queue, "merge", "--no-ff", "-q", "-m", "merge "+h, h); err != nil {
			_, _ = w.gitTry(w.queue, "merge", "--abort")
			return mergeq.Merged{}, fmt.Errorf("%w: %s", mergeq.ErrConflict, out)
		}
	}
	w.merge++
	ref := fmt.Sprintf("refs/factory/merge/%d", w.merge)
	w.git(w.queue, "update-ref", ref, "HEAD")
	return mergeq.Merged{Ref: ref, Base: base}, nil
}

func (g queueGit) FastForward(ctx context.Context, ref string) error {
	sha := g.w.git(g.w.queue, "rev-parse", ref)
	err := gitx.New(g.w.queue).FFPush(ctx, "origin", sha, "main")
	if errors.Is(err, gitx.ErrNotFastForward) {
		return mergeq.ErrBaseMoved
	}
	return err
}

// queueGate implements mergeq.Gate by running the repo's gates.sh through internal/gate.
type queueGate struct{ w *world }

func (g queueGate) Run(ctx context.Context, ref string) (mergeq.Verdict, error) {
	w := g.w
	w.git(w.queue, "checkout", "-q", "--detach", ref)
	res := gate.Run(ctx, gate.Spec{
		Command: "sh ./gates.sh", Dir: w.queue, Timeout: 60 * time.Second,
		Env: []string{"GOPROXY=off", "CGO_ENABLED=0"},
	})
	w.logf("gate %s %s", strings.Join(w.idsAt(ref), ","), res.Status)
	return mergeq.Verdict{Pass: res.Green(), LogTail: res.Tail}, nil
}

// idsAt names the tickets merged into a temp ref, from the commits it holds beyond main.
func (w *world) idsAt(ref string) []string {
	out, err := w.gitTry(w.queue, "log", "--format=%s", "origin/main.."+ref)
	if err != nil {
		return nil
	}
	var ids []string
	for _, line := range strings.Split(out, "\n") {
		if id, _, ok := strings.Cut(line, ": "); ok && w.trk.Tickets[api.TicketID(id)].ID != "" {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	return ids
}

// queueStore implements mergeq.Store on the fake tracker.
type queueStore struct{ w *world }

func (s queueStore) Queued(ctx context.Context) ([]mergeq.Entry, error) {
	var out []mergeq.Entry
	for _, id := range s.w.trk.queue {
		if s.w.trk.Phases[id] != api.PhaseQueued {
			continue
		}
		pr, err := s.PR(ctx, string(id))
		if err != nil {
			return nil, err
		}
		out = append(out, mergeq.Entry{ID: string(id), Head: pr.Head})
	}
	return out, nil
}

func (s queueStore) PR(ctx context.Context, id string) (mergeq.PRState, error) {
	j := s.w.disp.latest(api.TicketID(id))
	if j == nil {
		return mergeq.PRState{}, fmt.Errorf("no branch for %s", id)
	}
	head, err := s.w.originGit.RemoteRef(ctx, s.w.origin, "refs/heads/"+j.branch)
	if err != nil {
		return mergeq.PRState{}, err
	}
	p := s.w.trk.Phases[api.TicketID(id)]
	return mergeq.PRState{Head: head, Open: p == api.PhaseQueued, Merged: p == api.PhaseMerged}, nil
}

func (s queueStore) Landed(ctx context.Context, ids []string) error {
	for _, id := range ids {
		if err := s.w.trk.SetPhase(ctx, api.TicketID(id), api.PhaseMerged); err != nil {
			return err
		}
	}
	return nil
}

func (s queueStore) Eject(ctx context.Context, id, logTail string) error {
	tid := api.TicketID(id)
	if err := s.w.trk.Comment(ctx, tid, "Needs a human: the merge queue ejected this PR because the gate failed on it alone.\n\n"+logTail); err != nil {
		return err
	}
	return s.w.trk.SetPhase(ctx, tid, api.PhaseNeedsHuman)
}

func (s queueStore) Drop(_ context.Context, id, reason string) error {
	return fmt.Errorf("unexpected drop of %s: %s", id, reason)
}

func (s queueStore) Requeue(_ context.Context, id, head string) error {
	return fmt.Errorf("unexpected requeue of %s at %s", id, head)
}

// queueEvery is how many steps pass between merge queue runs. A lag between "done" and "merged" is
// what makes the file locks matter.
const queueEvery = 3

const stepLimit = 40

// step is one pass of the loop: advance the clock, reconcile, move done tickets into the queue,
// and run the queue on its schedule. The restart step first kills the store and the in-memory state.
func (w *world) step(n int, restartAt int) {
	w.t.Helper()
	w.clk.Advance(30 * time.Second)
	if n == restartAt {
		w.restart()
	}
	w.tick()
	if err := w.trk.enqueue(w.ctx); err != nil {
		w.t.Fatal(err)
	}
	if n%queueEvery == 0 {
		r := &mergeq.Runner{Git: queueGit{w}, Gate: queueGate{w}, Store: queueStore{w}, Cfg: mergeq.Config{BatchSize: 4}}
		rep, err := r.Run(w.ctx)
		if err != nil {
			w.t.Fatalf("merge queue: %v", err)
		}
		w.rep.Landed = append(w.rep.Landed, rep.Landed...)
		w.rep.Ejected = append(w.rep.Ejected, rep.Ejected...)
		w.rep.GateRuns += rep.GateRuns
	}
}

func (w *world) tick() {
	deps := reconcile.Deps{
		Dispatcher: w.disp, Tracker: w.trk, Observer: recordingObserver{w}, Now: w.clk.Now,
		OnError: func(err error) { w.t.Errorf("reconcile: %v", err) },
	}
	cfg := reconcile.Config{MaxConcurrent: 2}
	if w.state == nil {
		// A fresh process builds its state inside Tick, before it can be given the file locks.
		// So the first tick hides unclaimed tickets: it recovers what runs, and starts nothing.
		w.trk.freeze = true
		reconcile.Tick(w.ctx, deps, &w.state, cfg)
		w.trk.freeze = false
	}
	w.state.Locks = pick.Locks{Files: w.trk.heldFiles()}
	reconcile.Tick(w.ctx, deps, &w.state, cfg)
	w.state.Locks = pick.Locks{Files: w.trk.heldFiles()}
}

// run drives the loop until every ticket is finished or the step limit is hit; it returns the step count.
func (w *world) run(restartAt int) int {
	w.t.Helper()
	for n := 1; n <= stepLimit; n++ {
		w.step(n, restartAt)
		if w.trk.finished() {
			return n
		}
	}
	w.t.Fatalf("not finished after %d steps; phases %v", stepLimit, w.trk.Phases)
	return stepLimit
}

// restart kills the store file and the reconcile state, rebuilds the store from the tracker and git,
// and checks that the rows it rebuilt match what the live store held for the same tickets.
func (w *world) restart() {
	w.t.Helper()
	live, err := w.store.Dump(w.ctx)
	if err != nil {
		w.t.Fatal(err)
	}
	if err := w.store.Close(); err != nil {
		w.t.Fatal(err)
	}
	for _, suffix := range []string{"", "-wal", "-shm"} {
		_ = os.Remove(w.spath + suffix)
	}
	w.openStore()
	if err := w.store.Rebuild(w.ctx, w.trk, w.raw); err != nil {
		w.t.Fatalf("rebuild: %v", err)
	}
	fresh, err := w.store.Dump(w.ctx)
	if err != nil {
		w.t.Fatal(err)
	}
	active, _ := w.trk.Active(w.ctx)
	w.rebuildCompared = 0
	for _, t := range active {
		l, f := rowsFor(live, string(t.ID)), rowsFor(fresh, string(t.ID))
		if len(l) == 0 {
			continue // never observed before the kill; only the rebuild saw its push
		}
		w.rebuildCompared++
		if strings.Join(l, "\n") != strings.Join(f, "\n") {
			w.t.Errorf("rebuilt rows of %s differ from the live store\nlive:\n%s\nrebuilt:\n%s", t.ID, strings.Join(l, "\n"), strings.Join(f, "\n"))
		}
	}
	w.state = nil
}

// rowsFor picks the dump lines that belong to one ticket.
func rowsFor(dump []string, id string) []string {
	var out []string
	for _, line := range dump {
		if strings.Contains(line, " id="+id+" ") || strings.Contains(line, " ticket="+id+" ") {
			out = append(out, line)
		}
	}
	return out
}
