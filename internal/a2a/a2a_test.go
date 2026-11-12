package a2a

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

var update = flag.Bool("update", false, "rewrite golden files")

const testToken = "s3cret"

// fakeStore adds the two reads and writes the A2A server needs on top of the porttest tracker.
type fakeStore struct {
	mu   sync.Mutex
	tr   *porttest.Tracker
	next int
}

func (f *fakeStore) Create(_ context.Context, t api.Ticket) (api.TicketID, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.next++
	t.ID = api.TicketID(string(rune('0'+f.next)) + "01")
	t.Repo = "acme/app"
	f.tr.Tickets[t.ID] = t
	f.tr.Phases[t.ID] = api.PhaseReady
	return t.ID, nil
}

func (f *fakeStore) Phase(ctx context.Context, id api.TicketID) (api.Phase, error) {
	if _, err := f.tr.Get(ctx, id); err != nil {
		return "", err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tr.Phases[id], nil
}

func newDeps() (Deps, *porttest.Tracker, *porttest.Observer) {
	tr := porttest.NewTracker()
	ob := porttest.NewObserver()
	st := &fakeStore{tr: tr}
	return Deps{Tracker: tr, Filer: st, Phases: st, Observer: ob, Token: testToken, URL: "http://factory.test/"}, tr, ob
}

func rpc(t *testing.T, h http.Handler, token, method string, params any) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
	req := httptest.NewRequest(http.MethodPost, "/", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return rec.Code, out
}

func sendParams(text string) map[string]any {
	return map[string]any{"message": map[string]any{
		"kind": "message", "messageId": "m1", "role": "user",
		"parts": []any{map[string]any{"kind": "text", "text": text}},
	}}
}

// Acceptance: agent card golden.
func TestAgentCardGolden(t *testing.T) {
	deps, _, _ := newDeps()
	req := httptest.NewRequest(http.MethodGet, "/.well-known/agent-card.json", nil)
	rec := httptest.NewRecorder()
	NewHandler(deps).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("card status %d, want 200 without a token: %s", rec.Code, rec.Body)
	}
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, rec.Body.Bytes(), "", "  "); err != nil {
		t.Fatal(err)
	}
	pretty.WriteByte('\n')
	const golden = "testdata/agent-card.json"
	if *update {
		if err := os.WriteFile(golden, pretty.Bytes(), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(pretty.Bytes(), want) {
		t.Fatalf("agent card differs from %s (run go test -update):\n%s", golden, pretty.String())
	}
}

// Acceptance: phase-to-state table covering every api.Phase.
func TestStateForPhase(t *testing.T) {
	all := []api.Phase{
		api.PhaseReady, api.PhaseClaimed, api.PhaseRunning, api.PhaseStalled, api.PhaseRetryQueue,
		api.PhaseDone, api.PhaseQueued, api.PhaseMerged, api.PhaseNeedsHuman, api.PhaseCanceled,
	}
	want := map[api.Phase]string{
		api.PhaseReady: "submitted", api.PhaseClaimed: "submitted",
		api.PhaseRunning: "working", api.PhaseStalled: "working", api.PhaseRetryQueue: "working",
		api.PhaseDone: "working", api.PhaseQueued: "working",
		api.PhaseMerged: "completed", api.PhaseNeedsHuman: "input-required",
		api.PhaseCanceled: "canceled", PhaseFailed: "failed",
	}
	for _, p := range append(all, PhaseFailed) {
		got, ok := stateForPhase(p)
		if !ok || strings.ToLower(strings.TrimPrefix(string(got), "TASK_STATE_")) != strings.ReplaceAll(want[p], "-", "_") {
			t.Errorf("phase %q -> %q ok=%v, want %q", p, got, ok, want[p])
		}
	}
	if _, ok := stateForPhase("bogus"); ok {
		t.Error("unknown phase must not map")
	}
	if len(all) != len(phaseState)-1 {
		t.Errorf("table has %d rows, api has %d phases plus failed", len(phaseState), len(all))
	}
}

// Acceptance: send then get round trip on porttest fakes.
func TestSendThenGetRoundTrip(t *testing.T) {
	deps, tr, ob := newDeps()
	h := NewHandler(deps)

	code, out := rpc(t, h, testToken, "message/send", sendParams("add a health endpoint\nreturn 200 on /healthz"))
	if code != http.StatusOK || out["error"] != nil {
		t.Fatalf("send: %d %v", code, out)
	}
	res := out["result"].(map[string]any)
	id := res["id"].(string)
	tk, err := tr.Get(context.Background(), api.TicketID(id))
	if err != nil {
		t.Fatalf("task id %q does not map to a ticket: %v", id, err)
	}
	if tk.Title != "add a health endpoint" || !strings.Contains(tk.Body, "return 200 on /healthz") {
		t.Errorf("ticket = %+v", tk)
	}
	if len(tk.Labels) != 1 || tk.Labels[0] != LabelReady {
		t.Errorf("labels = %v, want [%s]", tk.Labels, LabelReady)
	}
	if st := res["status"].(map[string]any)["state"]; st != "submitted" {
		t.Errorf("send state = %v, want submitted", st)
	}

	state := func() (string, map[string]any) {
		_, out := rpc(t, h, testToken, "tasks/get", map[string]any{"id": id})
		if out["error"] != nil {
			t.Fatalf("get: %v", out["error"])
		}
		r := out["result"].(map[string]any)
		return r["status"].(map[string]any)["state"].(string), r
	}
	if s, _ := state(); s != "submitted" {
		t.Errorf("after send: %s", s)
	}
	tr.Phases[api.TicketID(id)] = api.PhaseRunning
	if s, _ := state(); s != "working" {
		t.Errorf("running: %s", s)
	}
	tr.Phases[api.TicketID(id)] = api.PhaseNeedsHuman
	if s, _ := state(); s != "input-required" {
		t.Errorf("needs-human: %s", s)
	}
	ob.Set(api.Observation{Ticket: api.TicketID(id), Attempt: 1, PR: 7})
	tr.Phases[api.TicketID(id)] = api.PhaseMerged
	s, r := state()
	if s != "completed" {
		t.Fatalf("merged: %s", s)
	}
	arts := r["artifacts"].([]any)
	parts := arts[0].(map[string]any)["parts"].([]any)
	if got := parts[0].(map[string]any)["text"]; got != "https://github.com/acme/app/pull/7" {
		t.Errorf("artifact = %v", got)
	}
}

func TestGetUnknownTask(t *testing.T) {
	deps, _, _ := newDeps()
	_, out := rpc(t, NewHandler(deps), testToken, "tasks/get", map[string]any{"id": "nope"})
	if out["error"] == nil {
		t.Fatalf("want an error for an unknown task, got %v", out)
	}
}

func TestSendRejectsEmptyText(t *testing.T) {
	deps, tr, _ := newDeps()
	_, out := rpc(t, NewHandler(deps), testToken, "message/send", sendParams("   "))
	if out["error"] == nil || len(tr.Tickets) != 0 {
		t.Fatalf("empty request must be refused and file nothing: %v", out)
	}
}

// Acceptance: unauthenticated request gets 401.
func TestAuth(t *testing.T) {
	deps, tr, _ := newDeps()
	h := NewHandler(deps)
	for _, tc := range []struct{ name, token string }{{"none", ""}, {"wrong", "nope"}} {
		code, _ := rpc(t, h, tc.token, "message/send", sendParams("x"))
		if code != http.StatusUnauthorized {
			t.Errorf("%s: status %d, want 401", tc.name, code)
		}
	}
	if len(tr.Tickets) != 0 {
		t.Error("an unauthenticated send filed a ticket")
	}
	deps.Token = ""
	if code, _ := rpc(t, NewHandler(deps), "", "message/send", sendParams("x")); code != http.StatusUnauthorized {
		t.Errorf("empty server token: status %d, want 401", code)
	}
}

// Acceptance: empty token refuses to start.
func TestCommandRefusesEmptyToken(t *testing.T) {
	t.Setenv(TokenEnv, "")
	opened := false
	cmd := NewCommand(func(context.Context) (Deps, error) { opened = true; return Deps{}, nil })
	cmd.SetArgs([]string{"--addr", "127.0.0.1:0"})
	cmd.SilenceUsage, cmd.SilenceErrors = true, true
	err := cmd.Execute()
	if err == nil || !strings.Contains(err.Error(), TokenEnv) {
		t.Fatalf("err = %v, want one naming %s", err, TokenEnv)
	}
	if opened {
		t.Error("deps were opened before the token check")
	}
}
