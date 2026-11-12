package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/logs"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/meter/price"
)

// TestRootCommandTree walks the root command tree: every command the ticket names is mounted.
func TestRootCommandTree(t *testing.T) {
	root := newRoot()
	have := map[string]bool{}
	for _, c := range root.Commands() {
		have[c.Name()] = true
	}
	for _, name := range []string{"version", "status", "run", "dispatch", "steer", "cancel", "retry", "queue",
		"config", "doctor", "board", "mcp", "dashboard", "first-run", "upgrade", "report",
		"init", "plan", "eval", "add", "packs", "logs", "serve", "a2a", "browsercheck", "checkpoint"} {
		if !have[name] {
			t.Errorf("command %q is not mounted on the root", name)
		}
	}
}

// TestTrackerTable builds every tracker name in the table; Symphony section 11 needs only Ready and Get.
func TestTrackerTable(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "t")
	t.Setenv("LINEAR_API_KEY", "t")
	t.Setenv("JIRA_API_TOKEN", "t")
	t.Setenv("JIRA_URL", "http://127.0.0.1:1")
	for name, repo := range map[string]string{"github": "acme/shop", "linear": "ENG", "jira": "SHOP"} {
		tr, err := buildTracker(config.Config{Tracker: name, Repo: repo})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if tr.Name() != name {
			t.Errorf("tracker %s reports name %q", name, tr.Name())
		}
	}
}

func TestTrackerErrors(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "")
	for _, tc := range []struct {
		name string
		cfg  config.Config
		want string
	}{
		{"unknown", config.Config{Tracker: "asana"}, "tracker: unknown \"asana\" (allowed: github, jira, linear)"},
		{"github without owner/repo", config.Config{Tracker: "github", Repo: "shop"}, "owner/name"},
		{"github without token", config.Config{Tracker: "github", Repo: "a/b"}, "GITHUB_TOKEN"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, err := buildTracker(tc.cfg)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want it to contain %q", err, tc.want)
			}
		})
	}
}

// TestDispatcherTable builds every dispatcher name in the table.
func TestDispatcherTable(t *testing.T) {
	t.Setenv("CLAUDE_ROUTINES_TOKEN", "t")
	t.Setenv("CLAUDE_ROUTINE_ID", "rt_1")
	t.Chdir(t.TempDir())
	for _, name := range []string{"claude-cloud", "fire", "local"} {
		d, err := buildDispatcher(context.Background(), config.Config{Dispatcher: name, Slots: 2})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if d.Name() == "" {
			t.Errorf("%s: empty name", name)
		}
	}
}

func TestDispatcherErrors(t *testing.T) {
	t.Setenv("CLAUDE_ROUTINES_TOKEN", "")
	t.Setenv("CLAUDE_ROUTINE_ID", "")
	for _, tc := range []struct{ name, want string }{
		{"mystery", "dispatcher: unknown \"mystery\" (allowed: claude-cloud, fire, local)"},
		{"claude-cloud", "CLAUDE_ROUTINES_TOKEN"},
		{"fire", "CLAUDE_ROUTINE_ID"},
	} {
		if tc.name == "fire" {
			t.Setenv("CLAUDE_ROUTINES_TOKEN", "t")
		}
		_, err := buildDispatcher(context.Background(), config.Config{Dispatcher: tc.name})
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: got %v, want %q", tc.name, err, tc.want)
		}
	}
}

// TestNoopQueueRefuses: off the GitHub tracker the merge queue is not configured and says so from Run.
func TestNoopQueueRefuses(t *testing.T) {
	var q core.MergeQueue = notConfiguredQueue{}
	if _, err := q.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("got %v", err)
	}
	if got, err := q.Queued(context.Background()); err != nil || len(got) != 0 {
		t.Fatalf("Queued = %v, %v", got, err)
	}
}

// TestRunHeadlessRealCore runs `factory run --headless` over a real core.Core on porttest fakes,
// injected through the deps seam, and reads NDJSON events from it (Symphony section 8.1 tick).
func TestRunHeadlessRealCore(t *testing.T) {
	t.Chdir(t.TempDir())
	trk := porttest.NewTracker(api.Ticket{ID: "1", Title: "one", Repo: "a/b"})
	disp := porttest.NewDispatcher(2)
	oldDeps := newDeps
	newDeps = func(config.Config) (core.Deps, error) {
		return core.Deps{Tracker: trk, Dispatcher: disp, Observer: porttest.NewObserver(), Store: nopStore{},
			Meter: meter.New(meter.Budgets{}, time.Now), Queue: notConfiguredQueue{}}, nil
	}
	t.Cleanup(func() { newDeps = oldDeps })

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var out syncBuf
	root := newRoot()
	root.SetOut(&out)
	root.SetErr(&bytes.Buffer{})
	root.SetArgs([]string{"run", "--headless"})
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()
	for ctx.Err() == nil && !strings.Contains(out.String(), `"kind"`) {
		time.Sleep(20 * time.Millisecond)
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	line, _, _ := strings.Cut(out.String(), "\n")
	var ev api.Event
	if err := json.Unmarshal([]byte(line), &ev); err != nil || ev.Kind == "" || ev.V != api.EventVersion {
		t.Fatalf("first line %q is not an event: %v", line, err)
	}
}

// syncBuf is a bytes.Buffer safe to read while the command writes.
type syncBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *syncBuf) Write(p []byte) (int, error) { s.mu.Lock(); defer s.mu.Unlock(); return s.b.Write(p) }
func (s *syncBuf) String() string              { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }

type nopStore struct{}

func (nopStore) PutTicket(context.Context, api.Ticket) error  { return nil }
func (nopStore) Apply(context.Context, api.Observation) error { return nil }

// TestNoControlForPlainCommands: version, doctor and config get never reach newControl.
func TestNoControlForPlainCommands(t *testing.T) {
	t.Chdir(t.TempDir())
	old := newControl
	built := 0
	newControl = func(config.Config) (api.Control, error) { built++; return nil, errors.New("constructed a Control") }
	t.Cleanup(func() { newControl = old })
	t.Setenv("PATH", t.TempDir())
	for _, args := range [][]string{{"version"}, {"doctor"}, {"config", "get", "slots"}, {"config", "explain", "slots"}} {
		root := newRoot()
		root.SetOut(&bytes.Buffer{})
		root.SetArgs(args)
		_ = root.Execute()
		if built != 0 {
			t.Fatalf("%v built a Control", args)
		}
	}
}

// TestControlCommandsGetControl: board, dashboard and mcp receive the Control through the seam.
func TestControlCommandsGetControl(t *testing.T) {
	f := &fakeControl{}
	use(t, f)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, args := range [][]string{{"dashboard", "--addr", "127.0.0.1:0"}, {"board"}} {
		root := newRoot()
		root.SetOut(&bytes.Buffer{})
		root.SetErr(&bytes.Buffer{})
		root.SetIn(strings.NewReader(""))
		root.SetArgs(args)
		err := root.ExecuteContext(ctx)
		if err != nil && (strings.Contains(err.Error(), "no control") || strings.Contains(err.Error(), "no Control")) {
			t.Errorf("%v: %v", args, err)
		}
	}
}

// TestGitHubDepsAreReal: on the GitHub tracker the loop gets the real merge queue, shadow mode wraps
// the dispatcher, and every dispatcher records its sessions. Other trackers keep the stand-in queue.
func TestGitHubDepsAreReal(t *testing.T) {
	t.Setenv("GITHUB_TOKEN", "t")
	t.Setenv("LINEAR_API_KEY", "t")
	t.Chdir(t.TempDir())
	live, err := buildDeps(config.Config{Tracker: "github", Repo: "acme/shop", Dispatcher: "local", Slots: 1, Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := live.Queue.(*mergeq.CoreQueue); !ok {
		t.Errorf("github queue is %T, want *mergeq.CoreQueue", live.Queue)
	}
	// The loop gets the step log, so a restart replays what the last run completed.
	if live.Log == nil {
		t.Error("deps carry no step log")
	}
	if _, err := os.Stat(stepLogDir); err != nil {
		t.Errorf("step log directory: %v", err)
	}
	d, err := buildDeps(config.Config{Tracker: "github", Repo: "acme/shop", Dispatcher: "local", Slots: 1, Shadow: true, Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	// Shadow mode must never merge: the real queue is wrapped and Run refuses.
	if _, ok := d.Queue.(shadowQueue); !ok {
		t.Errorf("shadow queue is %T, want shadowQueue", d.Queue)
	}
	if _, err := d.Queue.Run(context.Background()); err == nil || !strings.Contains(err.Error(), "shadow") {
		t.Errorf("shadow queue Run = %v, want a shadow-mode refusal", err)
	}
	if r, ok := d.Dispatcher.(recorded); !ok || d.Dispatcher.Name() != "shadow:local" || r.prices == nil {
		t.Errorf("dispatcher %T named %q, want recorded shadow:local with the price catalog", d.Dispatcher, d.Dispatcher.Name())
	}
	d, err = buildDeps(config.Config{Tracker: "linear", Repo: "ENG", Dispatcher: "local", Slots: 1})
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := d.Queue.(notConfiguredQueue); !ok || d.Dispatcher.Name() != "local" {
		t.Errorf("linear: queue %T, dispatcher %q", d.Queue, d.Dispatcher.Name())
	}
}

// TestLogsReadsTheRecordedSession: a dispatch through recorded is what `factory logs` finds.
func TestLogsReadsTheRecordedSession(t *testing.T) {
	ctx := context.Background()
	t.Chdir(t.TempDir())
	if _, err := logBackends().Source(ctx, "7"); !errors.Is(err, logs.ErrNoSession) {
		t.Fatalf("no store: got %v, want ErrNoSession", err)
	}
	st, err := openStore()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := (recorded{Dispatcher: porttest.NewDispatcher(1), st: st, models: &sessionModels{}}).Dispatch(ctx, api.Brief{Ticket: "7", Attempt: 1}); err != nil {
		t.Fatal(err)
	}
	_ = st.Close()
	_, err = logBackends().Source(ctx, "7")
	if err == nil || !strings.Contains(err.Error(), `dispatcher "fake"`) {
		t.Fatalf("got %v, want the recorded fake session to reach the factory lookup", err)
	}
}

// TestRecordedPricesUnreportedUsage: tokens a dispatcher reports without a cost are priced from the
// catalog by the model the session was briefed with; a reported cost and an unknown model stay as they are.
func TestRecordedPricesUnreportedUsage(t *testing.T) {
	t.Chdir(t.TempDir())
	ctx := context.Background()
	st, err := openStore()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	prices, err := price.Load()
	if err != nil {
		t.Fatal(err)
	}
	disp := porttest.NewDispatcher(3)
	r := recorded{Dispatcher: disp, st: st, prices: prices, models: &sessionModels{}}
	for _, tc := range []struct {
		ticket api.TicketID
		model  string
		usage  api.Usage
		want   float64
	}{
		{"1", "claude-sonnet-5", api.Usage{InputTokens: 1_000_000, OutputTokens: 100_000}, 3},
		{"2", "claude-sonnet-5", api.Usage{InputTokens: 1_000_000, CostUSD: 9}, 9},
		{"3", "no-such-model", api.Usage{InputTokens: 1_000_000}, 0},
	} {
		s, err := r.Dispatch(ctx, api.Brief{Ticket: tc.ticket, Attempt: 1, Model: tc.model})
		if err != nil {
			t.Fatal(err)
		}
		disp.UsageBy[s.Key] = tc.usage
		u, err := r.Usage(ctx, s)
		if err != nil || math.Abs(u.CostUSD-tc.want) > 1e-9 {
			t.Errorf("ticket %s: cost = %v (err %v), want %v", tc.ticket, u.CostUSD, err, tc.want)
		}
	}
}
