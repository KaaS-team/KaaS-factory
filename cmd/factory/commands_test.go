package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
)

// fakeControl records calls and replays a canned board and events.
type fakeControl struct {
	board  api.Board
	events []api.Event
	calls  []string
}

func (f *fakeControl) Board(context.Context) (api.Board, error) { return f.board, nil }
func (f *fakeControl) Dispatch(_ context.Context, id api.TicketID) error {
	f.calls = append(f.calls, "dispatch "+string(id))
	return nil
}
func (f *fakeControl) Steer(_ context.Context, id api.TicketID, m string) error {
	f.calls = append(f.calls, "steer "+string(id)+" "+m)
	return nil
}
func (f *fakeControl) Cancel(_ context.Context, id api.TicketID) error {
	f.calls = append(f.calls, "cancel "+string(id))
	return nil
}
func (f *fakeControl) Retry(_ context.Context, id api.TicketID) error {
	f.calls = append(f.calls, "retry "+string(id))
	return nil
}
func (f *fakeControl) CreateTicket(context.Context, string, string) (api.TicketID, error) {
	return "", nil
}
func (f *fakeControl) HandOff(context.Context, api.TicketID, string, string) error { return nil }
func (f *fakeControl) QueueFollowup(context.Context, api.TicketID, string) error   { return nil }
func (f *fakeControl) Repos(context.Context) ([]string, error)                     { return nil, nil }
func (f *fakeControl) Events(context.Context) (<-chan api.Event, error) {
	ch := make(chan api.Event, len(f.events))
	for _, e := range f.events {
		ch <- e
	}
	close(ch)
	return ch, nil
}

// use installs f as the Control for one test, in an empty working directory with a clean env.
func use(t *testing.T, f *fakeControl) *config.Config {
	t.Helper()
	t.Chdir(t.TempDir())
	var got config.Config
	old := newControl
	newControl = func(c config.Config) (api.Control, error) { got = c; return f, nil }
	t.Cleanup(func() { newControl = old })
	return &got
}

func runCLI(t *testing.T, args ...string) (stdout, stderr string, err error) {
	t.Helper()
	var o, e bytes.Buffer
	root := newRoot()
	root.SetOut(&o)
	root.SetErr(&e)
	root.SetArgs(args)
	err = root.Execute()
	return o.String(), e.String(), err
}

// Symphony §8.2 poll loop: the headless stream is the observable form of the loop's events.
func TestRunHeadless_PrintsExactlyOneEventPerLine(t *testing.T) {
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	want := []api.Event{
		{V: api.EventVersion, Time: base, Kind: "claimed", Ticket: "1"},
		{V: api.EventVersion, Time: base, Kind: "dispatched", Ticket: "1", Data: map[string]any{"attempt": float64(1)}},
		{V: api.EventVersion, Time: base, Kind: "done", Ticket: "1"},
	}
	use(t, &fakeControl{events: want})
	out, errOut, err := runCLI(t, "run", "--headless")
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSuffix(out, "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("got %d lines, want 3: %q", len(lines), out)
	}
	for i, l := range lines {
		var e api.Event
		dec := json.NewDecoder(strings.NewReader(l))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&e); err != nil {
			t.Fatalf("line %d: %v", i, err)
		}
		if e.Kind != want[i].Kind || e.V != api.EventVersion {
			t.Fatalf("line %d: got %+v", i, e)
		}
	}
	if strings.Contains(out, "streaming events") || strings.Contains(errOut, "{") {
		t.Fatalf("stdout carries logs or stderr carries events: %q %q", out, errOut)
	}
}

func TestRunSlotsFlagReachesConfig(t *testing.T) {
	cfg := use(t, &fakeControl{})
	if _, _, err := runCLI(t, "run", "--headless", "--slots", "7"); err != nil {
		t.Fatal(err)
	}
	if cfg.Slots != 7 {
		t.Fatalf("slots = %d, want 7", cfg.Slots)
	}
}

func TestStatus(t *testing.T) {
	board := api.Board{
		Slots: []api.Slot{
			{Ticket: api.Ticket{ID: "1", Title: "one"}, Phase: api.PhaseRunning},
			{Ticket: api.Ticket{ID: "2", Title: "two"}, Phase: api.PhaseStalled},
		},
		MergeQueue: []api.TicketID{"3"}, FiresLeft: 4,
	}
	for _, tc := range []struct {
		name string
		args []string
		chk  func(t *testing.T, out string)
	}{
		{"json decodes into Board", []string{"status", "--json"}, func(t *testing.T, out string) {
			var b api.Board
			if err := json.Unmarshal([]byte(out), &b); err != nil {
				t.Fatal(err)
			}
			if len(b.Slots) != 2 || b.FiresLeft != 4 || b.Slots[1].Phase != api.PhaseStalled {
				t.Fatalf("got %+v", b)
			}
		}},
		{"plain prints one row per slot", []string{"status"}, func(t *testing.T, out string) {
			rows := strings.Split(strings.TrimSpace(out), "\n")
			if len(rows) != 2 || !strings.Contains(rows[0], "running") || !strings.Contains(rows[1], "stalled") {
				t.Fatalf("got %q", out)
			}
		}},
		{"queue lists ready and merge queue", []string{"queue"}, func(t *testing.T, out string) {
			if strings.TrimSpace(out) != "merge-queue\t3" {
				t.Fatalf("got %q", out)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			use(t, &fakeControl{board: board})
			out, _, err := runCLI(t, tc.args...)
			if err != nil {
				t.Fatal(err)
			}
			tc.chk(t, out)
		})
	}
}

func TestTicketCommandsCallControlOnce(t *testing.T) {
	for _, tc := range []struct {
		args []string
		want string
	}{
		{[]string{"dispatch", "ENG-1"}, "dispatch ENG-1"},
		{[]string{"cancel", "ENG-1"}, "cancel ENG-1"},
		{[]string{"retry", "ENG-1"}, "retry ENG-1"},
		{[]string{"steer", "ENG-1", "use", "the", "cache"}, "steer ENG-1 use the cache"},
	} {
		t.Run(tc.args[0], func(t *testing.T) {
			f := &fakeControl{}
			use(t, f)
			if _, _, err := runCLI(t, tc.args...); err != nil {
				t.Fatal(err)
			}
			if len(f.calls) != 1 || f.calls[0] != tc.want {
				t.Fatalf("calls = %q, want [%q]", f.calls, tc.want)
			}
		})
	}
}

func TestTicketCommandNeedsExactlyOneArg(t *testing.T) {
	f := &fakeControl{}
	use(t, f)
	if _, _, err := runCLI(t, "dispatch"); err == nil {
		t.Fatal("want an error without a ticket")
	}
	if len(f.calls) != 0 {
		t.Fatalf("calls = %q", f.calls)
	}
}

// TestDefaultControlNamesTheMissingKey: the real newControl fails by naming the config key to set.
func TestDefaultControlNamesTheMissingKey(t *testing.T) {
	t.Chdir(t.TempDir())
	_, _, err := runCLI(t, "status")
	if err == nil || !strings.Contains(err.Error(), "key repo") {
		t.Fatalf("err = %v", err)
	}
}

func TestControlErrorPropagates(t *testing.T) {
	t.Chdir(t.TempDir())
	old := newControl
	newControl = func(config.Config) (api.Control, error) { return nil, errors.New("boom") }
	t.Cleanup(func() { newControl = old })
	if _, _, err := runCLI(t, "queue"); err == nil || err.Error() != "boom" {
		t.Fatalf("err = %v", err)
	}
}

func TestConfig(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	if err := os.MkdirAll(filepath.Join(dir, ".factory"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, config.RepoFileYAML), []byte("slots: 3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	t.Setenv("FACTORY_SLOTS", "5")
	out, _, err := runCLI(t, "config", "explain", "slots")
	if err != nil {
		t.Fatal(err)
	}
	first := strings.SplitN(out, "\n", 2)[0]
	if first != "slots = 5 (env), overrode builtin, repo" {
		t.Fatalf("first line %q", first)
	}
	if !strings.Contains(out, "repo\t3\t"+config.RepoFileYAML) {
		t.Fatalf("missing repo layer row: %q", out)
	}
	if got, _, _ := runCLI(t, "config", "get", "slots"); strings.TrimSpace(got) != "5" {
		t.Fatalf("get = %q", got)
	}
	if _, _, err := runCLI(t, "config", "get", "nope"); err == nil {
		t.Fatal("want unknown key error")
	}
	if _, _, err := runCLI(t, "config", "explain", "nope"); err == nil {
		t.Fatal("want unknown key error")
	}
}
