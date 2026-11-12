package a2a

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

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

func (f *fakeStore) set(id api.TicketID, p api.Phase) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tr.Phases[id] = p
}

func (f *fakeStore) Phase(ctx context.Context, id api.TicketID) (api.Phase, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if _, err := f.tr.Get(ctx, id); err != nil {
		return "", err
	}
	return f.tr.Phases[id], nil
}

func mustHandler(t *testing.T, deps Deps) http.Handler {
	t.Helper()
	h, err := NewHandler(deps)
	if err != nil {
		t.Fatal(err)
	}
	return h
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
	}, "configuration": map[string]any{"blocking": false}}
}

// Acceptance: agent card golden.
func TestAgentCardGolden(t *testing.T) {
	deps, _, _ := newDeps()
	req := httptest.NewRequest(http.MethodGet, "/.well-known/agent-card.json", nil)
	rec := httptest.NewRecorder()
	mustHandler(t, deps).ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("card status %d, want 200 without a token: %s", rec.Code, rec.Body)
	}
	// The signature differs on every request; TestAgentCardSignedAndVerifies checks it.
	var card map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &card); err != nil {
		t.Fatal(err)
	}
	delete(card, "signatures")
	unsigned, _ := json.Marshal(card)
	var pretty bytes.Buffer
	if err := json.Indent(&pretty, unsigned, "", "  "); err != nil {
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
		api.PhaseCanceled: "canceled",
	}
	for _, p := range all {
		got, ok := stateForPhase(p)
		if !ok || strings.ToLower(strings.TrimPrefix(string(got), "TASK_STATE_")) != strings.ReplaceAll(want[p], "-", "_") {
			t.Errorf("phase %q -> %q ok=%v, want %q", p, got, ok, want[p])
		}
	}
	if _, ok := stateForPhase("bogus"); ok {
		t.Error("unknown phase must not map")
	}
	if len(all) != len(phaseState) {
		t.Errorf("table has %d rows, api has %d phases", len(phaseState), len(all))
	}
}

// Acceptance: send then get round trip on porttest fakes.
func TestSendThenGetRoundTrip(t *testing.T) {
	deps, tr, ob := newDeps()
	st := deps.Filer.(*fakeStore)
	h := mustHandler(t, deps)

	code, out := rpc(t, h, testToken, "message/send", sendParams("add a health endpoint\nreturn 200 on /healthz"))
	if code != http.StatusOK || out["error"] != nil {
		t.Fatalf("send: %d %v", code, out)
	}
	res := out["result"].(map[string]any)
	id := res["id"].(string)
	ticket := res["metadata"].(map[string]any)[MetaTicket].(string)
	tk, err := tr.Get(context.Background(), api.TicketID(ticket))
	if err != nil {
		t.Fatalf("task %q names ticket %q which does not exist: %v", id, ticket, err)
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
	st.set(api.TicketID(ticket), api.PhaseRunning)
	if s, _ := state(); s != "working" {
		t.Errorf("running: %s", s)
	}
	st.set(api.TicketID(ticket), api.PhaseNeedsHuman)
	if s, _ := state(); s != "input-required" {
		t.Errorf("needs-human: %s", s)
	}
	ob.Set(api.Observation{Ticket: api.TicketID(ticket), Attempt: 1, PR: 7})
	st.set(api.TicketID(ticket), api.PhaseMerged)
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
	_, out := rpc(t, mustHandler(t, deps), testToken, "tasks/get", map[string]any{"id": "nope"})
	if out["error"] == nil {
		t.Fatalf("want an error for an unknown task, got %v", out)
	}
}

// A phase the table does not map is an error, and methods the server does not serve fail.
func TestUnmappedPhaseAndUnservedMethodsFail(t *testing.T) {
	deps, _, _ := newDeps()
	st := deps.Filer.(*fakeStore)
	h := mustHandler(t, deps)
	_, out := rpc(t, h, testToken, "message/send", sendParams("x"))
	res := out["result"].(map[string]any)
	id := res["id"].(string)
	st.set(api.TicketID(res["metadata"].(map[string]any)[MetaTicket].(string)), "failed")
	if _, out := rpc(t, h, testToken, "tasks/get", map[string]any{"id": id}); out["error"] == nil {
		t.Errorf("phase failed is not in the table, want an error, got %v", out)
	}
	for _, m := range []string{"tasks/cancel", "tasks/pushNotificationConfig/list"} { // v0.3 names
		if _, out := rpc(t, h, testToken, m, map[string]any{"id": id}); out["error"] == nil {
			t.Errorf("%s: want an error, got %v", m, out)
		}
	}
}

func TestSendRejectsEmptyText(t *testing.T) {
	deps, tr, _ := newDeps()
	_, out := rpc(t, mustHandler(t, deps), testToken, "message/send", sendParams("   "))
	if out["error"] == nil || len(tr.Tickets) != 0 {
		t.Fatalf("empty request must be refused and file nothing: %v", out)
	}
}

// Acceptance: unauthenticated request gets 401.
func TestAuth(t *testing.T) {
	deps, tr, _ := newDeps()
	h := mustHandler(t, deps)
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
	if code, _ := rpc(t, mustHandler(t, deps), "", "message/send", sendParams("x")); code != http.StatusUnauthorized {
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

func writeFile(p, c string) error { return os.WriteFile(p, []byte(c), 0o600) }

// TestCommandRejectsRebindingHost: the a2a listener answers 403 to a Host that is not loopback,
// before the bearer token is even looked at.
func TestCommandRejectsRebindingHost(t *testing.T) {
	t.Setenv(TokenEnv, "tok")
	probe, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := probe.Addr().String()
	_ = probe.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	pr, pw := io.Pipe()
	cmd := NewCommand(func(context.Context) (Deps, error) { return Deps{}, nil })
	cmd.SetErr(pw)
	cmd.SetArgs([]string{"--addr", addr})
	done := make(chan error, 1)
	go func() { done <- cmd.ExecuteContext(ctx) }()
	if _, err := bufio.NewReader(pr).ReadString('\n'); err != nil {
		t.Fatal(err)
	}
	var code int
	for i := 0; i < 50; i++ { // the line prints just before the listener binds
		req, _ := http.NewRequest(http.MethodGet, "http://"+addr+"/", nil)
		req.Host = "evil.example.com"
		if resp, err := http.DefaultClient.Do(req); err == nil {
			code = resp.StatusCode
			_ = resp.Body.Close()
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if code != http.StatusForbidden {
		t.Errorf("status %d, want 403", code)
	}
	cancel()
	<-done
}
