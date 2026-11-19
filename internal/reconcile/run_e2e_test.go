package reconcile_test

// The headless loop end to end on the local dispatcher: a fake `claude` shell script edits a file,
// commits and pushes to a real bare repo. The harness (the observer and the tracker), never the
// agent, reads the push and opens the pull request. The event stream is compared with a golden.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
)

// fakeClaude is a stand-in for `claude -p`: stream-json on stdout, one commit, one push. The ticket
// named slow never pushes on its first attempt.
const fakeClaude = `#!/bin/sh
exec 2>>"$HOME/agent.log"
b=$(git rev-parse --abbrev-ref HEAD)
id=${b#factory/}; id=${id%-a*}
echo '{"type":"system","subtype":"init"}'
if [ "$b" = "factory/slow-a1" ]; then sleep 120; exit 0; fi
echo "{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"text\",\"text\":\"editing $id\"}]}}"
echo "change for $id" > "$id.txt"
printf 'Report for %s\n' "$id" > report.md
git add -A
git -c user.name=fake -c user.email=fake@example.com commit -qm "ticket $id"
git push -q origin HEAD
echo '{"type":"result","subtype":"success"}'
`

type rig struct {
	t      *testing.T
	origin string
	now    time.Time
	mu     sync.Mutex
	prs    map[api.TicketID]int
	order  []api.TicketID  // tickets in seed order; a PR number follows this, not the race to open one
	leases map[string]bool // every lease ref that was ever created
	events []api.Event
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL="+os.DevNull, "GIT_CONFIG_SYSTEM="+os.DevNull)
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// harnessTracker is the fake tracker plus the harness duties: it holds a lease ref in the origin for
// each ticket it claims, releases it when the ticket ends, and opens the PR.
type harnessTracker struct {
	*porttest.Tracker
	r *rig
}

func (h harnessTracker) SetPhase(ctx context.Context, id api.TicketID, p api.Phase) error {
	ref := "refs/factory/lease/" + string(id)
	switch p {
	case api.PhaseClaimed:
		git(h.r.t, h.r.origin, "update-ref", ref, git(h.r.t, h.r.origin, "rev-parse", "main"))
		h.r.mu.Lock()
		h.r.leases[ref] = true
		h.r.mu.Unlock()
	case api.PhaseDone, api.PhaseNeedsHuman, api.PhaseCanceled, api.PhaseMerged:
		git(h.r.t, h.r.origin, "update-ref", "-d", ref)
	}
	return h.Tracker.SetPhase(ctx, id, p)
}

func (h harnessTracker) OpenPR(_ context.Context, id api.TicketID, branch, _ string, _ []string) (int, error) {
	h.r.mu.Lock()
	defer h.r.mu.Unlock()
	if n := h.r.prs[id]; n > 0 {
		return n, nil
	}
	h.r.prs[id] = 101 + slices.Index(h.r.order, id)
	return h.r.prs[id], nil
}

// gitObserver reads the origin: the branch, the report on it and the PR the harness opened.
type gitObserver struct{ r *rig }

func (o gitObserver) Observe(_ context.Context, id api.TicketID, attempt int) (api.Observation, error) {
	br := fmt.Sprintf("factory/%s-a%d", id, attempt)
	obs := api.Observation{Ticket: id, Attempt: attempt}
	if exec.Command("git", "-C", o.r.origin, "rev-parse", "--verify", "-q", "refs/heads/"+br).Run() != nil {
		return obs, nil
	}
	obs.Branch, obs.LastPush = br, o.r.now
	obs.HasReport = exec.Command("git", "-C", o.r.origin, "cat-file", "-e", br+":report.md").Run() == nil
	o.r.mu.Lock()
	obs.PR = o.r.prs[id]
	o.r.mu.Unlock()
	return obs, nil
}

type fixedClock struct{ r *rig }

func (c fixedClock) Now() time.Time                     { return c.r.now }
func (fixedClock) After(time.Duration) <-chan time.Time { return nil }

type landQueue struct{ ids []string }

func (q *landQueue) Enqueue(_ context.Context, id api.TicketID, _ int) error {
	q.ids = append(q.ids, string(id))
	return nil
}
func (*landQueue) Queued(context.Context) ([]mergeq.Entry, error) { return nil, nil }
func (q *landQueue) Run(context.Context) (mergeq.Report, error) {
	rep := mergeq.Report{Landed: q.ids}
	q.ids = nil
	return rep, nil
}

type nopStore struct{}

func (nopStore) PutTicket(context.Context, api.Ticket) error  { return nil }
func (nopStore) Apply(context.Context, api.Observation) error { return nil }

func newRig(t *testing.T, tickets ...api.Ticket) (*rig, *core.Core) {
	t.Helper()
	root := t.TempDir()
	r := &rig{t: t, origin: filepath.Join(root, "origin.git"), now: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		prs: map[api.TicketID]int{}, leases: map[string]bool{}}
	for _, t0 := range tickets {
		r.order = append(r.order, t0.ID)
	}
	git(t, root, "init", "-q", "--bare", "-b", "main", r.origin)
	seed := filepath.Join(root, "seed")
	git(t, root, "clone", "-q", r.origin, seed)
	if err := os.WriteFile(filepath.Join(seed, "README.md"), []byte("demo\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, seed, "add", "-A")
	git(t, seed, "-c", "user.name=s", "-c", "user.email=s@example.com", "commit", "-qm", "seed")
	git(t, seed, "push", "-q", "origin", "HEAD:refs/heads/main")
	repo := filepath.Join(root, "repo")
	git(t, root, "clone", "-q", r.origin, repo)
	bin := filepath.Join(root, "bin")
	if err := os.MkdirAll(bin, 0o755); err != nil {
		t.Fatal(err)
	}
	claude := filepath.Join(bin, "claude")
	if err := os.WriteFile(claude, []byte(fakeClaude), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	// The fake sits first on PATH, as it would for the CLI; the dispatcher finds it by name.
	t.Setenv("PATH", bin+":"+os.Getenv("PATH")) // exec resolves the name against this process
	env := []string{"PATH=" + bin + ":" + os.Getenv("PATH"), "HOME=" + root, "GIT_CONFIG_GLOBAL=" + os.DevNull, "GIT_CONFIG_SYSTEM=" + os.DevNull}
	steering := local.ClaudePreset
	steering.Steer = true
	disp, err := local.New(ctx, local.Config{
		Worktrees: local.GitWorktrees{Repo: repo, Root: filepath.Join(root, "wt")},
		Presets:   map[string]local.Preset{"claude": steering}, Binary: "claude", Environ: env, MaxConcurrent: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	c, err := core.New(core.Deps{Tracker: harnessTracker{porttest.NewTracker(tickets...), r}, Dispatcher: disp,
		Observer: gitObserver{r}, Store: nopStore{}, Meter: meter.New(meter.Budgets{}, func() time.Time { return r.now }),
		Queue: &landQueue{}, Clock: fixedClock{r}},
		core.Config{Reconcile: reconcile.Config{Tick: 10 * time.Second, StallAfter: 30 * time.Second, MaxConcurrent: 2}})
	if err != nil {
		t.Fatal(err)
	}
	ev, err := c.Events(ctx)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for e := range ev {
			r.mu.Lock()
			r.events = append(r.events, e)
			r.mu.Unlock()
		}
	}()
	return r, c
}

func (r *rig) count(kind string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for _, e := range r.events {
		if e.Kind == kind {
			n++
		}
	}
	return n
}

func (r *rig) leaseRefs() string { return git(r.t, r.origin, "for-each-ref", "refs/factory/lease") }

// stream is the NDJSON the CLI prints, minus time and tick lines (those depend on scheduling), grouped
// by ticket so two sessions running side by side give one stable order.
func (r *rig) stream() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	by := map[string][]string{}
	for _, e := range r.events {
		if e.Kind == core.KindTick {
			continue
		}
		e.Time = time.Time{}
		b, _ := json.Marshal(e)
		by[string(e.Ticket)] = append(by[string(e.Ticket)], string(b))
	}
	var ids []string
	for id := range by {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	var out strings.Builder
	for _, id := range ids {
		for _, l := range by[id] {
			out.WriteString(l + "\n")
		}
	}
	return out.String()
}

func golden(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", name)
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != got {
		t.Fatalf("stream differs from %s (UPDATE_GOLDEN=1 rewrites it)\n--- got\n%s--- want\n%s", path, got, want)
	}
}

func tk(id string, n int) api.Ticket {
	return api.Ticket{ID: api.TicketID(id), Repo: "demo/app", Title: "ticket " + id, CreatedAt: time.Date(2026, 1, 1, 0, n, 0, 0, time.UTC)}
}

// Acceptance (f-run): two tickets go from ready to a pushed branch, a report and an opened PR,
// both lease refs are released, and the stream matches the golden.
func TestRunTwoTicketsToPullRequests(t *testing.T) {
	r, c := newRig(t, tk("t1", 1), tk("t2", 2))
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	for r.count(core.KindMerged) < 2 && ctx.Err() == nil {
		c.Tick(ctx)
		time.Sleep(50 * time.Millisecond)
	}
	for r.count(core.KindMerged) < 2 {
		t.Fatalf("loop did not finish: %s\n%s", r.stream(), r.agentLog())
	}
	if len(r.prs) != 2 || r.prs["t1"] == 0 || r.prs["t2"] == 0 {
		t.Fatalf("PRs = %v", r.prs)
	}
	for _, id := range []string{"t1", "t2"} {
		br := "factory/" + id + "-a1"
		if got := git(t, r.origin, "show", br+":report.md"); got != "Report for "+id {
			t.Fatalf("report on %s = %q", br, got)
		}
	}
	if len(r.leases) != 2 {
		t.Fatalf("leases taken = %v", r.leases)
	}
	if got := r.leaseRefs(); got != "" {
		t.Fatalf("lease refs left behind:\n%s", got)
	}
	golden(t, "run_stream.golden", r.stream())
}

// Acceptance (f-run): a session that never pushes gets one steer, then a retry after the Symphony
// 8.4 backoff, and the second attempt opens the PR. Both show in the stream.
func TestStalledSessionGetsOneSteerThenRetry(t *testing.T) {
	r, c := newRig(t, tk("slow", 1))
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	for r.count(core.KindMerged) < 1 && ctx.Err() == nil {
		c.Tick(ctx)
		time.Sleep(50 * time.Millisecond)
		// Time moves while attempt 1 stalls and while the retry waits out its backoff. It freezes once
		// attempt 2 is dispatched, so a slow machine cannot stall the healthy retry.
		if r.count(core.KindDispatched) < 2 {
			r.mu.Lock()
			r.now = r.now.Add(10 * time.Second)
			r.mu.Unlock()
		}
	}
	if r.count(core.KindMerged) < 1 {
		t.Fatalf("loop did not finish: %s\n%s", r.stream(), r.agentLog())
	}
	if got := r.count(core.KindStalled); got != 1 {
		t.Fatalf("steers = %d, want 1\n%s", got, r.stream())
	}
	if got := r.leaseRefs(); got != "" {
		t.Fatalf("lease refs left behind:\n%s", got)
	}
	golden(t, "run_stall_stream.golden", r.stream())
}

func (r *rig) agentLog() string {
	b, _ := os.ReadFile(filepath.Join(filepath.Dir(r.origin), "agent.log"))
	return string(b)
}
