package mcp_test

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"github.com/KaaS-team/factory/internal/api"
	factorymcp "github.com/KaaS-team/factory/internal/mcp"
)

// fakeControl is a Control that records mutating calls (Symphony §8 operator actions).
type fakeControl struct {
	mu    sync.Mutex
	calls []string
	board api.Board
	evs   []api.Event
}

func (f *fakeControl) rec(s string, id api.TicketID) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s+":"+string(id))
}
func (f *fakeControl) Board(context.Context) (api.Board, error) { return f.board, nil }
func (f *fakeControl) Dispatch(_ context.Context, id api.TicketID) error {
	f.rec("dispatch", id)
	return nil
}
func (f *fakeControl) Steer(_ context.Context, id api.TicketID, m string) error {
	f.rec("steer", id)
	return nil
}
func (f *fakeControl) Cancel(_ context.Context, id api.TicketID) error {
	f.rec("cancel", id)
	return nil
}
func (f *fakeControl) Retry(_ context.Context, id api.TicketID) error {
	f.rec("retry", id)
	return nil
}
func (f *fakeControl) Events(context.Context) (<-chan api.Event, error) {
	ch := make(chan api.Event, len(f.evs))
	for _, e := range f.evs {
		ch <- e
	}
	close(ch)
	return ch, nil
}

func newFake() *fakeControl {
	t7 := api.Ticket{ID: "7", Repo: "o/r", Title: "seven", CreatedAt: time.Unix(0, 0).UTC()}
	t8 := api.Ticket{ID: "8", Repo: "o/r", Title: "eight", CreatedAt: time.Unix(0, 0).UTC()}
	return &fakeControl{
		board: api.Board{
			Slots: []api.Slot{{
				Ticket: t7, Phase: api.PhaseRunning,
				Usage:  api.Usage{InputTokens: 12345, CostUSD: 9.99},
				Budget: api.Budget{Tokens: 777777, USD: 5},
			}},
			Ready:      []api.Ticket{t8},
			MergeQueue: []api.TicketID{"7"},
			FiresLeft:  3,
		},
		evs: []api.Event{
			{V: 1, Kind: "dispatched", Ticket: "7", Data: map[string]any{"model": "secret-model", "tokens": 5}},
			{V: 1, Kind: "dispatched", Ticket: "8"},
		},
	}
}

func connect(t *testing.T, ctl api.Control, h factorymcp.Handlers) *sdk.ClientSession {
	t.Helper()
	ctx := t.Context()
	ct, st := sdk.NewInMemoryTransports()
	srv := factorymcp.NewServer(ctl, h)
	ss, err := srv.Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ss.Close() })
	cs, err := sdk.NewClient(&sdk.Implementation{Name: "test", Version: "0"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = cs.Close() })
	return cs
}

var toolNames = []string{"plan", "approve_plan", "list_tickets", "status", "dispatch", "steer", "cancel", "retry", "queue", "explain_config", "first_run", "report"}

// callArgs gives each tool a valid input.
var callArgs = map[string]map[string]any{
	"plan":           {"goal": "g"},
	"approve_plan":   {"plan_id": "p"},
	"list_tickets":   {},
	"status":         {},
	"dispatch":       {"ticket": "7"},
	"steer":          {"ticket": "7", "message": "hi"},
	"cancel":         {"ticket": "7"},
	"retry":          {"ticket": "7"},
	"queue":          {},
	"explain_config": {},
	"first_run":      {},
	"report":         {},
}

func text(t *testing.T, r *sdk.CallToolResult) string {
	t.Helper()
	var b strings.Builder
	for _, c := range r.Content {
		if tc, ok := c.(*sdk.TextContent); ok {
			b.WriteString(tc.Text)
		}
	}
	if r.StructuredContent != nil {
		j, _ := json.Marshal(r.StructuredContent)
		b.Write(j)
	}
	return b.String()
}

func TestListsExactlyTwelveTools(t *testing.T) {
	cs := connect(t, newFake(), factorymcp.Handlers{})
	var got []string
	for tool, err := range cs.Tools(t.Context(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, tool.Name)
	}
	if len(got) != len(toolNames) {
		t.Fatalf("got %v", got)
	}
	want := map[string]bool{}
	for _, n := range toolNames {
		want[n] = true
	}
	for _, n := range got {
		if !want[n] {
			t.Errorf("unexpected tool %q", n)
		}
		delete(want, n)
	}
	if len(want) != 0 {
		t.Errorf("missing %v", want)
	}
}

func TestStatusReturnsBoard(t *testing.T) {
	f := newFake()
	cs := connect(t, f, factorymcp.Handlers{})
	r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "status", Arguments: map[string]any{}})
	if err != nil || r.IsError {
		t.Fatalf("err=%v r=%+v", err, r)
	}
	var b struct {
		Slots      []struct{ Ticket api.Ticket }
		Ready      []api.Ticket
		MergeQueue []string `json:"merge_queue"`
		FiresLeft  int      `json:"fires_left"`
	}
	raw, _ := json.Marshal(r.StructuredContent)
	if err := json.Unmarshal(raw, &b); err != nil {
		t.Fatal(err)
	}
	if len(b.Slots) != 1 || b.Slots[0].Ticket.ID != "7" || len(b.Ready) != 1 || b.Ready[0].ID != "8" || b.FiresLeft != 3 || len(b.MergeQueue) != 1 {
		t.Errorf("board mismatch: %s", raw)
	}
}

func TestMutatingToolsReachControlOnce(t *testing.T) {
	f := newFake()
	cs := connect(t, f, factorymcp.Handlers{})
	for _, n := range []string{"dispatch", "steer", "cancel", "retry"} {
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: n, Arguments: callArgs[n]})
		if err != nil || r.IsError {
			t.Fatalf("%s: err=%v r=%+v", n, err, r)
		}
	}
	want := []string{"dispatch:7", "steer:7", "cancel:7", "retry:7"}
	if strings.Join(f.calls, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v", f.calls)
	}
}

func TestNilHandlerIsToolErrorNamingTool(t *testing.T) {
	cs := connect(t, newFake(), factorymcp.Handlers{})
	for _, n := range []string{"plan", "approve_plan", "explain_config", "first_run", "report"} {
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: n, Arguments: callArgs[n]})
		if err != nil {
			t.Fatalf("%s: protocol error %v", n, err)
		}
		if !r.IsError || !strings.Contains(text(t, r), n) || !strings.Contains(text(t, r), "not available in this build") {
			t.Errorf("%s: %+v", n, r)
		}
	}
}

func TestResources(t *testing.T) {
	cs := connect(t, newFake(), factorymcp.Handlers{})
	r, err := cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: "factory://board"})
	if err != nil {
		t.Fatal(err)
	}
	var b struct {
		Slots []struct{ Ticket api.Ticket } `json:"slots"`
	}
	if err := json.Unmarshal([]byte(r.Contents[0].Text), &b); err != nil || len(b.Slots) != 1 || b.Slots[0].Ticket.ID != "7" {
		t.Errorf("board: %v %s", err, r.Contents[0].Text)
	}
	r, err = cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: "factory://ticket/7"})
	if err != nil {
		t.Fatal(err)
	}
	var tk struct {
		Ticket api.Ticket `json:"ticket"`
		Events []struct {
			Kind   string
			Ticket string
		} `json:"events"`
	}
	if err := json.Unmarshal([]byte(r.Contents[0].Text), &tk); err != nil || tk.Ticket.ID != "7" || len(tk.Events) != 1 || tk.Events[0].Ticket != "7" {
		t.Errorf("ticket: %v %s", err, r.Contents[0].Text)
	}
	if _, err := cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: "factory://ticket/99"}); err == nil {
		t.Error("unknown ticket should error")
	}
}

var leak = regexp.MustCompile(`(?i)token|cost|usd|model|12345|777777|9\.99`)

func TestNoToolOutputLeaksUsageCostOrModel(t *testing.T) {
	h := factorymcp.Handlers{
		Plan:          func(context.Context, factorymcp.PlanInput) (string, error) { return "fine", nil },
		ApprovePlan:   func(context.Context, factorymcp.ApprovePlanInput) (string, error) { return "fine", nil },
		ExplainConfig: func(context.Context) (string, error) { return "fine", nil },
		FirstRun:      func(context.Context) (string, error) { return "fine", nil },
		Report:        func(context.Context) (string, error) { return "fine", nil },
	}
	cs := connect(t, newFake(), h)
	for _, n := range toolNames {
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: n, Arguments: callArgs[n]})
		if err != nil || r.IsError {
			t.Fatalf("%s: err=%v r=%+v", n, err, r)
		}
		if m := leak.FindString(text(t, r)); m != "" {
			t.Errorf("%s output leaks %q: %s", n, m, text(t, r))
		}
	}
	for _, uri := range []string{"factory://board", "factory://ticket/7"} {
		r, err := cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: uri})
		if err != nil {
			t.Fatal(err)
		}
		if m := leak.FindString(r.Contents[0].Text); m != "" {
			t.Errorf("%s leaks %q: %s", uri, m, r.Contents[0].Text)
		}
	}
}

func TestCommandWithoutControlFails(t *testing.T) {
	cmd := factorymcp.NewCommand()
	cmd.SetArgs(nil)
	if err := cmd.ExecuteContext(t.Context()); err == nil || !strings.Contains(err.Error(), "no control plane") {
		t.Errorf("err = %v", err)
	}
}
