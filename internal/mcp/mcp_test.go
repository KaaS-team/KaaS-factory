package mcp_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/pflag"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	factorymcp "github.com/KaaS-team/factory/internal/mcp"
)

func newFake() *porttest.Control {
	t7 := api.Ticket{ID: "7", Repo: "o/r", Title: "seven", CreatedAt: time.Unix(0, 0).UTC()}
	t8 := api.Ticket{ID: "8", Repo: "o/r", Title: "eight", CreatedAt: time.Unix(0, 0).UTC()}
	f := porttest.NewControl(api.Board{
		Slots: []api.Slot{{
			Ticket: t7, Phase: api.PhaseRunning,
			Usage:  api.Usage{InputTokens: 12345, CostUSD: 9.99},
			Budget: api.Budget{Tokens: 777777, USD: 5},
		}},
		Ready:      []api.Ticket{t8},
		MergeQueue: []api.TicketID{"7"},
		FiresLeft:  3,
	})
	f.Seed("7", api.Event{V: 1, Time: time.Unix(10, 0).UTC(), Kind: "dispatched", Ticket: "7", Data: map[string]any{"model": "secret-model", "tokens": 5}})
	f.Seed("7", api.Event{V: 1, Time: time.Unix(20, 0).UTC(), Kind: "pushed", Ticket: "7"})
	return f
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

var toolNames = []string{"plan", "approve_plan", "list_tickets", "status", "dispatch", "steer", "cancel", "retry", "queue", "explain_config", "first_run", "report",
	"create_task", "hand_off_task", "queue_followup", "list_events", "list_repos"}

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
	"create_task":    {"title": "t", "body": "b"},
	"hand_off_task":  {"id": "7", "to": "bob", "note": "n"},
	"queue_followup": {"id": "7", "message": "m"},
	"list_events":    {"id": "7"},
	"list_repos":     {},
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

func TestListsExactlyTheFactoryTools(t *testing.T) {
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
	for _, n := range []string{"dispatch", "steer", "cancel", "retry", "create_task", "hand_off_task", "queue_followup"} {
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: n, Arguments: callArgs[n]})
		if err != nil || r.IsError {
			t.Fatalf("%s: err=%v r=%+v", n, err, r)
		}
	}
	want := []string{"dispatch 7", "steer 7: hi", "cancel 7", "retry 7", "create: t: b", "hand_off 7 to bob: n", "followup 7: m"}
	if got := f.Calls(); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("calls = %v", got)
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
		HistoryAvailable bool `json:"history_available"`
	}
	if err := json.Unmarshal([]byte(r.Contents[0].Text), &tk); err != nil || tk.Ticket.ID != "7" || len(tk.Events) != 2 || tk.Events[0].Ticket != "7" || !tk.HistoryAvailable {
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

type ticketRes struct {
	Ticket api.Ticket `json:"ticket"`
	Events []struct {
		Kind string `json:"kind"`
	} `json:"events"`
	HistoryAvailable bool   `json:"history_available"`
	HistoryNote      string `json:"history_note"`
}

func readTicket(t *testing.T, cs *sdk.ClientSession, id string) ticketRes {
	t.Helper()
	r, err := cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: "factory://ticket/" + id})
	if err != nil {
		t.Fatal(err)
	}
	var tk ticketRes
	if err := json.Unmarshal([]byte(r.Contents[0].Text), &tk); err != nil {
		t.Fatal(err)
	}
	return tk
}

func TestTicketResourceHistory(t *testing.T) {
	tests := []struct {
		name      string
		ctl       func(*porttest.Control) api.Control
		wantKinds []string
		available bool
	}{
		{"with Historian", func(f *porttest.Control) api.Control { return f }, []string{"dispatched", "pushed"}, true},
		{"without Historian", func(f *porttest.Control) api.Control { return f.ControlOnly() }, []string{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake()
			cs := connect(t, tc.ctl(f), factorymcp.Handlers{})
			tk := readTicket(t, cs, "7")
			kinds := []string{}
			for _, e := range tk.Events {
				kinds = append(kinds, e.Kind)
			}
			if strings.Join(kinds, ",") != strings.Join(tc.wantKinds, ",") {
				t.Errorf("events = %v, want %v", kinds, tc.wantKinds)
			}
			if tk.HistoryAvailable != tc.available {
				t.Errorf("history_available = %v", tk.HistoryAvailable)
			}
			if !tc.available && !strings.Contains(tk.HistoryNote, "history is unavailable") {
				t.Errorf("note = %q", tk.HistoryNote)
			}
			if tk.Ticket.ID != "7" {
				t.Errorf("ticket = %+v", tk.Ticket)
			}
		})
	}
}

func TestStatusForOneTicketIncludesHistory(t *testing.T) {
	f := newFake()
	cs := connect(t, f, factorymcp.Handlers{})
	r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "status", Arguments: map[string]any{"ticket": "7"}})
	if err != nil || r.IsError {
		t.Fatalf("err=%v r=%+v", err, r)
	}
	var out struct {
		Slots  []any `json:"slots"`
		Detail *ticketRes
	}
	raw, _ := json.Marshal(r.StructuredContent)
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	if out.Detail == nil || len(out.Detail.Events) != 2 || !out.Detail.HistoryAvailable || len(out.Slots) != 1 {
		t.Fatalf("status = %s", raw)
	}
	if m := leak.FindString(string(raw)); m != "" {
		t.Errorf("status leaks %q: %s", m, raw)
	}
	// Without a ticket the board alone comes back.
	r, _ = cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "status", Arguments: map[string]any{}})
	raw, _ = json.Marshal(r.StructuredContent)
	if strings.Contains(string(raw), "history") {
		t.Errorf("board status carries history: %s", raw)
	}
	// An unknown ticket is a tool error.
	r, err = cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "status", Arguments: map[string]any{"ticket": "99"}})
	if err != nil || !r.IsError {
		t.Errorf("unknown ticket: err=%v r=%+v", err, r)
	}
	// A Control without Historian still answers and says so.
	cs2 := connect(t, newFake().ControlOnly(), factorymcp.Handlers{})
	r, _ = cs2.CallTool(t.Context(), &sdk.CallToolParams{Name: "status", Arguments: map[string]any{"ticket": "7"}})
	raw, _ = json.Marshal(r.StructuredContent)
	if !strings.Contains(string(raw), "history is unavailable") {
		t.Errorf("no unavailable note: %s", raw)
	}
}

// spy wraps a Control to record every method the server calls (Symphony §11 reads, §8 writes)
// and to fail them with an operator-detail error on demand.
type spy struct {
	api.Control
	failWith error
	calls    []string
}

func (s *spy) Board(ctx context.Context) (api.Board, error) {
	s.calls = append(s.calls, "board")
	if s.failWith != nil {
		return api.Board{}, s.failWith
	}
	return s.Control.Board(ctx)
}
func (s *spy) Dispatch(ctx context.Context, id api.TicketID) error {
	s.calls = append(s.calls, "dispatch")
	if s.failWith != nil {
		return s.failWith
	}
	return s.Control.Dispatch(ctx, id)
}
func (s *spy) Steer(ctx context.Context, id api.TicketID, m string) error {
	s.calls = append(s.calls, "steer")
	if s.failWith != nil {
		return s.failWith
	}
	return s.Control.Steer(ctx, id, m)
}
func (s *spy) Cancel(ctx context.Context, id api.TicketID) error {
	s.calls = append(s.calls, "cancel")
	if s.failWith != nil {
		return s.failWith
	}
	return s.Control.Cancel(ctx, id)
}
func (s *spy) Retry(ctx context.Context, id api.TicketID) error {
	s.calls = append(s.calls, "retry")
	if s.failWith != nil {
		return s.failWith
	}
	return s.Control.Retry(ctx, id)
}

func (s *spy) CreateTicket(ctx context.Context, title, body string) (api.TicketID, error) {
	s.calls = append(s.calls, "create")
	if s.failWith != nil {
		return "", s.failWith
	}
	return s.Control.CreateTicket(ctx, title, body)
}
func (s *spy) HandOff(ctx context.Context, id api.TicketID, to, note string) error {
	s.calls = append(s.calls, "hand_off")
	if s.failWith != nil {
		return s.failWith
	}
	return s.Control.HandOff(ctx, id, to, note)
}
func (s *spy) QueueFollowup(ctx context.Context, id api.TicketID, m string) error {
	s.calls = append(s.calls, "followup")
	if s.failWith != nil {
		return s.failWith
	}
	return s.Control.QueueFollowup(ctx, id, m)
}
func (s *spy) Repos(ctx context.Context) ([]string, error) {
	s.calls = append(s.calls, "repos")
	if s.failWith != nil {
		return nil, s.failWith
	}
	return s.Control.Repos(ctx)
}

// History makes the spy an api.Historian, the path list_events reads.
func (s *spy) History(ctx context.Context, id api.TicketID) ([]api.Event, error) {
	s.calls = append(s.calls, "history")
	if s.failWith != nil {
		return nil, s.failWith
	}
	return s.Control.(api.Historian).History(ctx, id)
}

func TestEachToolCallsMatchingControlMethod(t *testing.T) {
	want := map[string]string{"list_tickets": "board", "status": "board", "queue": "board",
		"dispatch": "dispatch", "steer": "steer", "cancel": "cancel", "retry": "retry",
		"create_task": "create", "hand_off_task": "hand_off", "queue_followup": "followup", "list_events": "history", "list_repos": "repos"}
	for tool, method := range want {
		sp := &spy{Control: newFake()}
		cs := connect(t, sp, factorymcp.Handlers{})
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: tool, Arguments: callArgs[tool]})
		if err != nil || r.IsError {
			t.Fatalf("%s: err=%v r=%+v", tool, err, r)
		}
		if len(sp.calls) != 1 || sp.calls[0] != method {
			t.Errorf("%s: control calls = %v, want [%s]", tool, sp.calls, method)
		}
	}
}

func TestListsBothResources(t *testing.T) {
	cs := connect(t, newFake(), factorymcp.Handlers{})
	var uris []string
	for r, err := range cs.Resources(t.Context(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		uris = append(uris, r.URI)
	}
	var tmpl []string
	for r, err := range cs.ResourceTemplates(t.Context(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		tmpl = append(tmpl, r.URITemplate)
	}
	if strings.Join(uris, ",") != "factory://board" || strings.Join(tmpl, ",") != "factory://ticket/{id}" {
		t.Errorf("resources %v templates %v", uris, tmpl)
	}
}

var operatorDetail = regexp.MustCompile(`(?i)/home/|\.go:\d|goroutine|panic|10\.0\.0\.5|sk-secret|stack`)

func TestErrorsAreToolErrorsWithoutOperatorDetail(t *testing.T) {
	boom := errors.New("dial tcp 10.0.0.5:5432 (/home/op/x.go:42) token sk-secret goroutine 1 panic stack")
	failing := func(context.Context) (string, error) { return "", boom }
	h := factorymcp.Handlers{
		Plan:          func(context.Context, factorymcp.PlanInput) (string, error) { return "", boom },
		ApprovePlan:   func(context.Context, factorymcp.ApprovePlanInput) (string, error) { return "", boom },
		ExplainConfig: failing, FirstRun: failing, Report: failing,
	}
	cs := connect(t, &spy{Control: newFake(), failWith: boom}, h)
	for _, n := range toolNames {
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: n, Arguments: callArgs[n]})
		if err != nil {
			t.Fatalf("%s: protocol error %v", n, err)
		}
		if !r.IsError {
			t.Errorf("%s: want tool error", n)
		}
		if m := operatorDetail.FindString(text(t, r)); m != "" {
			t.Errorf("%s leaks %q: %s", n, m, text(t, r))
		}
		if !strings.Contains(text(t, r), n) {
			t.Errorf("%s: error does not name the tool: %s", n, text(t, r))
		}
	}
	for _, uri := range []string{"factory://board", "factory://ticket/7"} {
		_, err := cs.ReadResource(t.Context(), &sdk.ReadResourceParams{URI: uri})
		if err == nil || operatorDetail.MatchString(err.Error()) {
			t.Errorf("%s: err = %v", uri, err)
		}
	}
}

// tsTools is every tool of the retired TS server factory-mcp (src/tools.ts) and the Go tool that serves
// it. Nine keep their name; list_tasks, get_task and get_metrics map to existing Go tools, and spend is
// covered by the operator-only report tool, which is a Handlers entry and not a Control tool.
var tsTools = []struct{ ts, goTool string }{
	{"list_tasks", "list_tickets"}, {"get_task", "status"}, {"create_task", "create_task"},
	{"hand_off_task", "hand_off_task"}, {"approve_plan", "approve_plan"}, {"steer", "steer"},
	{"queue_followup", "queue_followup"}, {"retry", "retry"}, {"list_events", "list_events"},
	{"spend", "report"}, {"list_repos", "list_repos"}, {"get_metrics", "status"},
}

func listTools(t *testing.T, cs *sdk.ClientSession) map[string]*sdk.Tool {
	t.Helper()
	got := map[string]*sdk.Tool{}
	for tool, err := range cs.Tools(t.Context(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		got[tool.Name] = tool
	}
	return got
}

// Structure: the registered tool set contains the Go tool of every TS tool, so a dropped tool fails.
func TestEveryTSToolIsServed(t *testing.T) {
	got := listTools(t, connect(t, newFake(), factorymcp.Handlers{}))
	for _, m := range tsTools {
		if got[m.goTool] == nil {
			t.Errorf("TS tool %s: Go tool %s is not registered", m.ts, m.goTool)
		}
	}
	for _, n := range toolNames {
		if got[n] == nil {
			t.Errorf("tool %s is not registered", n)
		}
	}
}

// The name, description and annotations of the five ported tools are those of tools.ts.
func TestPortedToolsKeepTSDescriptionAndAnnotations(t *testing.T) {
	got := listTools(t, connect(t, newFake(), factorymcp.Handlers{}))
	read := [4]bool{true, false, true, false}
	write := [4]bool{false, false, false, false}
	cases := []struct {
		name, desc string
		hints      [4]bool // readOnly, destructive, idempotent, openWorld
	}{
		{"create_task", "Create a new task. Each call creates another task, so repeating it makes duplicates. Never removes or changes existing tasks.", write},
		{"hand_off_task", "Hand a task to another assignee. This replaces the current assignee, so the previous owner loses it. Repeating the same hand-off leaves the same end state.", [4]bool{false, true, true, false}},
		{"queue_followup", "Queue a follow-up message for a run. Each call queues another message. Does not remove or edit earlier ones.", write},
		{"list_events", "List the events of one run, as the factory returns them. Read-only.", read},
		{"list_repos", "List the repositories the factory knows about. Read-only.", read},
	}
	for _, c := range cases {
		tool := got[c.name]
		if tool == nil {
			t.Errorf("%s missing", c.name)
			continue
		}
		if tool.Description != c.desc {
			t.Errorf("%s description = %q", c.name, tool.Description)
		}
		a := tool.Annotations
		if a == nil || a.DestructiveHint == nil || a.OpenWorldHint == nil {
			t.Errorf("%s: annotations not explicit: %+v", c.name, a)
			continue
		}
		if h := [4]bool{a.ReadOnlyHint, *a.DestructiveHint, a.IdempotentHint, *a.OpenWorldHint}; h != c.hints {
			t.Errorf("%s hints (readOnly, destructive, idempotent, openWorld) = %v, want %v", c.name, h, c.hints)
		}
	}
}

// zod's min(1) on the TS inputs: an empty or missing required field is a tool error naming the tool.
func TestPortedToolsRejectEmptyRequiredInputs(t *testing.T) {
	f := newFake()
	cs := connect(t, f, factorymcp.Handlers{})
	cases := []struct {
		tool string
		args map[string]any
	}{
		{"create_task", map[string]any{"title": ""}},
		{"create_task", map[string]any{}},
		{"hand_off_task", map[string]any{"id": "", "to": "bob"}},
		{"hand_off_task", map[string]any{"id": "7", "to": ""}},
		{"queue_followup", map[string]any{"id": "7", "message": ""}},
		{"queue_followup", map[string]any{"id": "", "message": "m"}},
		{"list_events", map[string]any{"id": ""}},
	}
	for _, c := range cases {
		r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: c.tool, Arguments: c.args})
		if err == nil && (r == nil || !r.IsError) {
			t.Errorf("%s %v: accepted", c.tool, c.args)
		}
	}
	if got := f.Calls(); len(got) != 0 {
		t.Errorf("invalid input reached Control: %v", got)
	}
}

func TestOptionalInputsMayBeLeftOut(t *testing.T) {
	f := newFake()
	cs := connect(t, f, factorymcp.Handlers{})
	for _, c := range []struct {
		tool string
		args map[string]any
	}{{"create_task", map[string]any{"title": "t"}}, {"hand_off_task", map[string]any{"id": "7", "to": "bob"}}} {
		if r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: c.tool, Arguments: c.args}); err != nil || r.IsError {
			t.Fatalf("%s: err=%v r=%+v", c.tool, err, r)
		}
	}
	if got, want := strings.Join(f.Calls(), ","), "create: t: ,hand_off 7 to bob"; got != want {
		t.Errorf("calls = %q, want %q", got, want)
	}
}

func TestListEventsAndListRepos(t *testing.T) {
	f := newFake()
	f.ReposVal = []string{"o/r", "o/s"}
	cs := connect(t, f, factorymcp.Handlers{})
	r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "list_events", Arguments: map[string]any{"id": "7"}})
	if err != nil || r.IsError {
		t.Fatalf("err=%v r=%+v", err, r)
	}
	var ev struct {
		Events []struct{ Kind, Ticket string }
	}
	raw, _ := json.Marshal(r.StructuredContent)
	if err := json.Unmarshal(raw, &ev); err != nil || len(ev.Events) != 2 || ev.Events[0].Kind != "dispatched" || ev.Events[1].Kind != "pushed" {
		t.Errorf("events: %v %s", err, raw)
	}
	if strings.Contains(string(raw), "secret-model") {
		t.Errorf("event data leaked: %s", raw)
	}
	r, err = cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "list_repos", Arguments: map[string]any{}})
	if err != nil || r.IsError {
		t.Fatalf("err=%v r=%+v", err, r)
	}
	raw, _ = json.Marshal(r.StructuredContent)
	if string(raw) != `{"repos":["o/r","o/s"]}` {
		t.Errorf("repos: %s", raw)
	}
	// A Control that keeps no history is a tool error, not an empty list.
	cs2 := connect(t, newFake().ControlOnly(), factorymcp.Handlers{})
	r, _ = cs2.CallTool(t.Context(), &sdk.CallToolParams{Name: "list_events", Arguments: map[string]any{"id": "7"}})
	if !r.IsError || !strings.Contains(text(t, r), "history is unavailable") {
		t.Errorf("no-history list_events: %+v", r)
	}
}

func TestCreateTaskReturnsTheNewID(t *testing.T) {
	cs := connect(t, newFake(), factorymcp.Handlers{})
	r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "create_task", Arguments: map[string]any{"title": "t"}})
	if err != nil || r.IsError {
		t.Fatalf("err=%v r=%+v", err, r)
	}
	raw, _ := json.Marshal(r.StructuredContent)
	if string(raw) != `{"id":"new-1"}` {
		t.Errorf("create_task = %s", raw)
	}
}

const httpToken = "secret-token"

const initBody = `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}`

func httpServer(t *testing.T) *httptest.Server {
	t.Helper()
	h, err := factorymcp.Handler(factorymcp.NewServer(newFake(), factorymcp.Handlers{}), httpToken)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts
}

func post(t *testing.T, url, auth, body string) (int, string) {
	t.Helper()
	req, _ := http.NewRequestWithContext(t.Context(), http.MethodPost, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	b, _ := io.ReadAll(io.LimitReader(res.Body, 1<<16))
	return res.StatusCode, strings.TrimSpace(string(b))
}

// http.test.ts "no token or a wrong token gets 401; the right token is let through", plus the 404 rule.
func TestHTTPAuthAndPaths(t *testing.T) {
	ts := httpServer(t)
	cases := []struct {
		name, path, auth string
		status           int
	}{
		{"no token", "/mcp", "", 401},
		{"wrong token", "/mcp", "Bearer nope", 401},
		{"token without Bearer", "/mcp", httpToken, 401},
		{"prefix of the token", "/mcp", "Bearer secret", 401},
		{"token plus suffix", "/mcp", "Bearer " + httpToken + "x", 401},
		{"right token", "/mcp", "Bearer " + httpToken, 200},
		{"other path, right token", "/other", "Bearer " + httpToken, 404},
		{"root, right token", "/", "Bearer " + httpToken, 404},
		{"other path, no token", "/other", "", 401},
	}
	for _, c := range cases {
		status, body := post(t, ts.URL+c.path, c.auth, initBody)
		if status != c.status {
			t.Errorf("%s: status %d, want %d", c.name, status, c.status)
		}
		if c.status == 401 && body != "unauthorized" {
			t.Errorf("%s: body %q", c.name, body)
		}
	}
}

type headerAdder struct{ auth string }

func (h headerAdder) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", h.auth)
	return http.DefaultTransport.RoundTrip(r)
}

// http.test.ts "with the token, tools/list answers every tool and a tool call works".
func TestHTTPClientListsToolsAndCalls(t *testing.T) {
	ts := httpServer(t)
	tr := &sdk.StreamableClientTransport{Endpoint: ts.URL + "/mcp", HTTPClient: &http.Client{Transport: headerAdder{"Bearer " + httpToken}}}
	cs, err := sdk.NewClient(&sdk.Implementation{Name: "t", Version: "0"}, nil).Connect(t.Context(), tr, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cs.Close() }()
	got := listTools(t, cs)
	for _, n := range toolNames {
		if got[n] == nil {
			t.Errorf("tool %s missing over HTTP", n)
		}
	}
	r, err := cs.CallTool(t.Context(), &sdk.CallToolParams{Name: "list_tickets", Arguments: map[string]any{}})
	if err != nil || r.IsError || !strings.Contains(text(t, r), "seven") {
		t.Errorf("list_tickets: err=%v r=%+v", err, r)
	}
}

// http.test.ts "an empty token is refused at startup", for the handler and for the command.
func TestHTTPEmptyTokenIsRefused(t *testing.T) {
	if _, err := factorymcp.Handler(factorymcp.NewServer(newFake(), factorymcp.Handlers{}), ""); err == nil {
		t.Error("Handler accepted an empty token")
	}
	t.Setenv(factorymcp.TokenEnv, "")
	opened := false
	cmd := factorymcp.NewCommand(factorymcp.WithControl(func() (api.Control, factorymcp.Handlers, error) {
		opened = true
		return newFake(), factorymcp.Handlers{}, nil
	}))
	cmd.SetArgs([]string{"--http", "127.0.0.1:0"})
	ctx, cancel := context.WithTimeout(t.Context(), 2*time.Second) // a command that does not refuse would serve until here
	defer cancel()
	if err := cmd.ExecuteContext(ctx); err == nil || !strings.Contains(err.Error(), factorymcp.TokenEnv) {
		t.Errorf("err = %v", err)
	}
	if opened {
		t.Error("the command built a control plane before refusing")
	}
}

// Default bind is loopback; an explicit host is kept.
func TestBindAddr(t *testing.T) {
	for in, want := range map[string]string{
		"8080": "127.0.0.1:8080", ":8080": "127.0.0.1:8080", "127.0.0.1:0": "127.0.0.1:0",
		"0.0.0.0:9": "0.0.0.0:9", "localhost:7": "localhost:7",
	} {
		if got := factorymcp.BindAddr(in); got != want {
			t.Errorf("BindAddr(%q) = %q, want %q", in, got, want)
		}
	}
}

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.String()
}

// The command serves /mcp with the token from the environment, never logs it, and stops with its context.
func TestHTTPCommandServesWithEnvToken(t *testing.T) {
	t.Setenv(factorymcp.TokenEnv, httpToken)
	var logs lockedBuf
	cmd := factorymcp.NewCommand(factorymcp.WithControl(func() (api.Control, factorymcp.Handlers, error) {
		return newFake(), factorymcp.Handlers{}, nil
	}))
	cmd.SetArgs([]string{"--http", "127.0.0.1:0"})
	cmd.SetOut(&logs)
	cmd.SetErr(&logs)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- cmd.ExecuteContext(ctx) }()
	re := regexp.MustCompile(`http://(127\.0\.0\.1:\d+)/mcp`)
	var addr string
	for i := 0; i < 300 && addr == ""; i++ {
		if m := re.FindStringSubmatch(logs.String()); m != nil {
			addr = m[1]
		}
		time.Sleep(10 * time.Millisecond)
	}
	if addr == "" {
		t.Fatalf("command did not report its address: %q", logs.String())
	}
	if status, _ := post(t, "http://"+addr+"/mcp", "", initBody); status != 401 {
		t.Errorf("no token: %d", status)
	}
	if status, _ := post(t, "http://"+addr+"/mcp", "Bearer "+httpToken, initBody); status != 200 {
		t.Errorf("env token: %d", status)
	}
	cancel()
	if err := <-done; err != nil {
		t.Errorf("shutdown: %v", err)
	}
	if strings.Contains(logs.String(), httpToken) {
		t.Errorf("token in the log: %q", logs.String())
	}
}

// http.test.ts "bin reads credentials from env only and offers --http": the token has no flag, and the
// comparison in mcp.go is the one constant-time check.
func TestTokenIsEnvOnlyAndComparedInConstantTime(t *testing.T) {
	cmd := factorymcp.NewCommand()
	if cmd.Flags().Lookup("http") == nil {
		t.Error("no --http flag")
	}
	cmd.Flags().VisitAll(func(f *pflag.Flag) {
		if f.Name != "http" && f.Name != "help" {
			t.Errorf("unexpected flag --%s", f.Name)
		}
	})
	src, err := os.ReadFile("mcp.go")
	if err != nil {
		t.Fatal(err)
	}
	if n := strings.Count(string(src), "subtle.ConstantTimeCompare("); n != 1 {
		t.Errorf("ConstantTimeCompare appears %d times, want 1", n)
	}
	if regexp.MustCompile(`(?i)Header\.Get\("Authorization"\)\s*[!=]=`).Match(src) {
		t.Error("the Authorization header is compared with ==")
	}
}
