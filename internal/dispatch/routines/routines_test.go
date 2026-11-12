package routines

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var update = flag.Bool("update", false, "rewrite the request goldens")

const token = "test-token-123"

// rec is one request the client made, as the goldens store it.
type rec struct {
	Method string          `json:"method"`
	Path   string          `json:"path"`
	Auth   string          `json:"authorization"`
	Type   string          `json:"content_type,omitempty"`
	Body   json.RawMessage `json:"body,omitempty"`
}

// fakeAPI is a stateful stand-in for the routines API. The wire shapes are
// the ones this package assumes; they are not confirmed against the live API.
type fakeAPI struct {
	mu       sync.Mutex
	reqs     []rec
	triggers []map[string]any
	sessions []map[string]any
	status   int // when non-zero, every reply is this status
	usage    map[string]any
}

func (f *fakeAPI) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	raw, _ := io.ReadAll(r.Body)
	rc := rec{Method: r.Method, Path: r.URL.RequestURI(), Auth: r.Header.Get("Authorization"), Type: r.Header.Get("Content-Type")}
	if len(raw) > 0 {
		rc.Body = raw
	}
	f.reqs = append(f.reqs, rc)
	if f.status != 0 {
		w.WriteHeader(f.status)
		_, _ = w.Write([]byte(`{"error":"secret detail"}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	switch {
	case r.Method == "GET" && r.URL.Path == "/v1/code/triggers":
		var out []map[string]any
		for _, t := range f.triggers {
			if t["name"] == r.URL.Query().Get("name") {
				out = append(out, t)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
	case r.Method == "POST" && r.URL.Path == "/v1/code/triggers":
		var body map[string]any
		_ = json.Unmarshal(raw, &body)
		body["id"] = "trig_" + string(rune('a'+len(f.triggers)))
		f.triggers = append(f.triggers, body)
		_ = json.NewEncoder(w).Encode(body)
	case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/v1/code/triggers/") && strings.HasSuffix(r.URL.Path, "/run"):
		id := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/v1/code/triggers/"), "/run")
		s := map[string]any{"id": "sess_" + string(rune('a'+len(f.sessions))), "trigger_id": id, "status": "running", "url": "https://example.test/s"}
		if f.usage != nil {
			s["usage"] = f.usage
		}
		f.sessions = append(f.sessions, s)
		_ = json.NewEncoder(w).Encode(s)
	case r.Method == "GET" && r.URL.Path == "/v1/code/sessions":
		var out []map[string]any
		for _, s := range f.sessions {
			if (r.URL.Query().Get("trigger_id") == "" || s["trigger_id"] == r.URL.Query().Get("trigger_id")) &&
				(r.URL.Query().Get("id") == "" || s["id"] == r.URL.Query().Get("id")) {
				out = append(out, s)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": out})
	case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/cancel"):
		_, _ = w.Write([]byte(`{}`))
	default:
		w.WriteHeader(404)
	}
}

func setup(t *testing.T) (*Dispatcher, *fakeAPI) {
	t.Helper()
	f := &fakeAPI{}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	d, err := New(Config{BaseURL: srv.URL, Token: token, MaxConcurrent: 5, Now: func() time.Time { return time.Unix(1700000000, 0).UTC() }})
	if err != nil {
		t.Fatal(err)
	}
	return d, f
}

var bf = api.Brief{Ticket: "7", Attempt: 2, Name: "v9-7-a2.md", Repo: "o/r", Base: "main", Branch: "factory/7-a2", Text: "x"}

func golden(t *testing.T, name string, got any) {
	t.Helper()
	b, err := json.MarshalIndent(got, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	path := "testdata/" + name + ".golden.json"
	if *update {
		if err := os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%v (run with -update once and review the file)", err)
	}
	if string(want) != string(b) {
		t.Errorf("%s differs\ngot:\n%s\nwant:\n%s", name, b, want)
	}
}

// Acceptance: create and run requests match recorded goldens.
func TestDispatchRequestsMatchGoldens(t *testing.T) {
	d, f := setup(t)
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	golden(t, "dispatch_requests", f.reqs)
	if s.Key != "factory-7-a2" || s.ID != "sess_a" || s.Ticket != "7" || s.Attempt != 2 || s.Dispatcher != "routines" || s.URL != "https://example.test/s" {
		t.Errorf("session = %+v", s)
	}
	if !s.StartedAt.Equal(time.Unix(1700000000, 0)) {
		t.Errorf("started %v", s.StartedAt)
	}
}

// Acceptance: the same key twice creates one trigger (and runs it once).
func TestDispatchSameKeyCreatesOneTrigger(t *testing.T) {
	d, f := setup(t)
	a, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	b, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	if len(f.triggers) != 1 || len(f.sessions) != 1 {
		t.Fatalf("%d triggers, %d sessions", len(f.triggers), len(f.sessions))
	}
	if a != b {
		t.Errorf("sessions differ: %+v vs %+v", a, b)
	}
	// A fresh client (a restarted factory) finds it too.
	d2, err := New(Config{BaseURL: d.cfg.BaseURL, Token: token, Now: d.cfg.Now})
	if err != nil {
		t.Fatal(err)
	}
	if c, err := d2.Dispatch(context.Background(), bf); err != nil || c != a {
		t.Fatalf("restart: %+v %v", c, err)
	}
	if len(f.triggers) != 1 || len(f.sessions) != 1 {
		t.Fatalf("after restart: %d triggers, %d sessions", len(f.triggers), len(f.sessions))
	}
	// Another attempt is another key.
	next := bf
	next.Attempt, next.Name, next.Branch = 3, "v9-7-a3.md", "factory/7-a3"
	if _, err := d.Dispatch(context.Background(), next); err != nil {
		t.Fatal(err)
	}
	if len(f.triggers) != 2 {
		t.Errorf("attempt 3: %d triggers", len(f.triggers))
	}
}

// A crash between create and run leaves a trigger with no session: run it, do not create again.
func TestDispatchRunsAnExistingTriggerThatNeverRan(t *testing.T) {
	d, f := setup(t)
	f.triggers = []map[string]any{{"id": "trig_pre", "name": "factory-7-a2"}}
	if _, err := d.Dispatch(context.Background(), bf); err != nil {
		t.Fatal(err)
	}
	if len(f.triggers) != 1 || len(f.sessions) != 1 || f.sessions[0]["trigger_id"] != "trig_pre" {
		t.Errorf("triggers %v sessions %v", f.triggers, f.sessions)
	}
}

func TestDispatchRefusesABriefWithTheWrongName(t *testing.T) {
	d, f := setup(t)
	b := bf
	b.Name = "v9-8-a1.md"
	if _, err := d.Dispatch(context.Background(), b); err == nil {
		t.Fatal("no error")
	}
	if len(f.reqs) != 0 {
		t.Errorf("%d requests were sent", len(f.reqs))
	}
}

func TestErrorsNameTheKindAndNeverTheBody(t *testing.T) {
	rows := []struct {
		status int
		kind   Kind
	}{{401, KindAuth}, {403, KindAuth}, {404, KindNotFound}, {429, KindRateLimited}, {500, KindProvider}, {400, KindProvider}}
	for _, r := range rows {
		d, f := setup(t)
		f.status = r.status
		_, err := d.Dispatch(context.Background(), bf)
		var e *Error
		if !errors.As(err, &e) || e.Kind != r.kind || e.Status != r.status {
			t.Errorf("%d: %v", r.status, err)
			continue
		}
		if strings.Contains(err.Error(), "secret detail") || strings.Contains(err.Error(), token) {
			t.Errorf("%d: error leaks: %v", r.status, err)
		}
	}
}

func TestUsageStatusSteerCancel(t *testing.T) {
	d, f := setup(t)
	f.usage = map[string]any{"input_tokens": 10, "output_tokens": 5, "cache_read_tokens": 2, "cache_write_tokens": 1, "cost_usd": 0.25}
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	u, err := d.Usage(context.Background(), s)
	if err != nil || u != (api.Usage{InputTokens: 10, OutputTokens: 5, CacheReadTokens: 2, CacheWriteTokens: 1, CostUSD: 0.25}) {
		t.Errorf("usage %+v %v", u, err)
	}
	if st, err := d.Status(context.Background(), s); err != nil || st != "running" {
		t.Errorf("status %q %v", st, err)
	}
	if err := d.Steer(context.Background(), s, "hi"); !errors.Is(err, ErrSteerUnsupported) {
		t.Errorf("steer: %v", err)
	}
	if err := d.Cancel(context.Background(), s); err != nil {
		t.Fatal(err)
	}
	last := f.reqs[len(f.reqs)-1]
	if last.Method != "POST" || last.Path != "/v1/code/sessions/sess_a/cancel" {
		t.Errorf("cancel request: %+v", last)
	}
	// A session the API does not list is not found, not zero usage.
	if _, err := d.Usage(context.Background(), api.Session{ID: "sess_nope"}); !errors.As(err, new(*Error)) {
		t.Errorf("unknown session: %v", err)
	}
}

func TestUsageWithoutAUsageObjectIsZero(t *testing.T) {
	d, _ := setup(t)
	s, _ := d.Dispatch(context.Background(), bf)
	if u, err := d.Usage(context.Background(), s); err != nil || u != (api.Usage{}) {
		t.Errorf("%+v %v", u, err)
	}
}

func TestNameCapsAndConfig(t *testing.T) {
	d, _ := setup(t)
	if d.Name() != "routines" {
		t.Error(d.Name())
	}
	if c := d.Caps(); c.MaxConcurrent != 5 || !c.Remote || c.CanPushWorkflows || c.FiresPerHour != 0 {
		t.Errorf("caps %+v", c)
	}
	if _, err := New(Config{BaseURL: "", Token: "x"}); err == nil {
		t.Error("empty base url accepted")
	}
	if _, err := New(Config{BaseURL: "http://x", Token: ""}); err == nil {
		t.Error("empty token accepted")
	}
}

var _ api.Dispatcher = (*Dispatcher)(nil)

// The trigger has no schedule and starts disabled; no request carries a provider key.
func TestRequestsHaveNoCronAndNoProviderVariables(t *testing.T) {
	d, f := setup(t)
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.Usage(context.Background(), s)
	_ = d.Cancel(context.Background(), s)
	var created map[string]any
	for _, r := range f.reqs {
		if r.Method == "POST" && r.Path == "/v1/code/triggers" {
			_ = json.Unmarshal(r.Body, &created)
		}
		raw, _ := json.Marshal(r)
		if strings.Contains(strings.ToUpper(string(raw)), "ANTHROPIC_") {
			t.Errorf("request carries a provider variable: %s", raw)
		}
	}
	if created["enabled"] != false {
		t.Errorf("enabled = %v", created["enabled"])
	}
	for _, k := range []string{"cron", "schedule", "cron_expression"} {
		if _, ok := created[k]; ok {
			t.Errorf("trigger has %q", k)
		}
	}
}
