package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/meter"
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
		"init", "plan", "eval", "add", "packs", "logs"} {
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

// TestNoopQueueRefuses: the merge queue is not wired yet and says so from Run.
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
