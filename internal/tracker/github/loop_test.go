package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

// hub is a small stateful GitHub: issues with labels, comments, permissions and pull requests.
type hub struct {
	mu       sync.Mutex
	labels   map[int][]string
	titles   map[int]string
	comments []hubComment
	perms    map[string]string
	pulls    []map[string]any
	nextID   int64
}

type hubComment struct {
	ID    int64
	Issue int
	User  string
	Body  string
	At    time.Time
}

func newHub(t *testing.T) (*hub, *gh.Tracker) {
	t.Helper()
	h := &hub{labels: map[int][]string{}, titles: map[int]string{}, perms: map[string]string{"bot": "admin"}, nextID: 100}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /user", func(w http.ResponseWriter, _ *http.Request) { writeJSON(w, map[string]any{"login": "bot"}) })
	mux.HandleFunc("GET /repos/o/r/issues", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		want := r.URL.Query().Get("labels")
		var out []map[string]any
		for n := range h.titles {
			if want == "" || slices.Contains(h.labels[n], want) {
				out = append(out, h.issue(n))
			}
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("GET /repos/o/r/issues/{n}", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		n, _ := strconv.Atoi(r.PathValue("n"))
		writeJSON(w, h.issue(n))
	})
	mux.HandleFunc("POST /repos/o/r/issues/{n}/labels", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		n, _ := strconv.Atoi(r.PathValue("n"))
		var names []string
		_ = json.NewDecoder(r.Body).Decode(&names)
		h.labels[n] = append(h.labels[n], names...)
		writeJSON(w, []any{})
	})
	mux.HandleFunc("DELETE /repos/o/r/issues/{n}/labels/{name}", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		n, _ := strconv.Atoi(r.PathValue("n"))
		h.labels[n] = slices.DeleteFunc(h.labels[n], func(l string) bool { return l == r.PathValue("name") })
		writeJSON(w, []any{})
	})
	mux.HandleFunc("GET /repos/o/r/issues/{n}/comments", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		n, _ := strconv.Atoi(r.PathValue("n"))
		out := []map[string]any{}
		for _, c := range h.comments {
			if c.Issue == n {
				out = append(out, map[string]any{"id": c.ID, "body": c.Body, "created_at": c.At, "user": map[string]any{"login": c.User}})
			}
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("POST /repos/o/r/issues/{n}/comments", func(w http.ResponseWriter, r *http.Request) {
		n, _ := strconv.Atoi(r.PathValue("n"))
		var in struct{ Body string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		writeJSON(w, map[string]any{"id": h.post(n, "bot", in.Body)})
	})
	mux.HandleFunc("PATCH /repos/o/r/issues/comments/{id}", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		id, _ := strconv.ParseInt(r.PathValue("id"), 10, 64)
		var in struct{ Body string }
		_ = json.NewDecoder(r.Body).Decode(&in)
		for i := range h.comments {
			if h.comments[i].ID == id {
				h.comments[i].Body = in.Body
			}
		}
		writeJSON(w, map[string]any{"id": id})
	})
	mux.HandleFunc("GET /repos/o/r/collaborators/{login}/permission", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		p := h.perms[r.PathValue("login")]
		if p == "" {
			p = "none"
		}
		writeJSON(w, map[string]any{"permission": p})
	})
	mux.HandleFunc("GET /repos/o/r/pulls", func(w http.ResponseWriter, _ *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		writeJSON(w, make([]map[string]any, len(h.pulls)))
	})
	mux.HandleFunc("POST /repos/o/r/pulls", func(w http.ResponseWriter, r *http.Request) {
		h.mu.Lock()
		defer h.mu.Unlock()
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		in["number"] = 40 + len(h.pulls)
		h.pulls = append(h.pulls, in)
		writeJSON(w, map[string]any{"number": in["number"]})
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	tr, err := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: srv.URL + "/", HTTPClient: srv.Client(), Now: func() time.Time { return loopT0 }})
	if err != nil {
		t.Fatal(err)
	}
	return h, tr
}

var loopT0 = time.Date(2026, 3, 4, 5, 6, 7, 0, time.UTC)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func (h *hub) issue(n int) map[string]any {
	ls := []map[string]any{}
	for _, l := range h.labels[n] {
		ls = append(ls, map[string]any{"name": l})
	}
	return map[string]any{"number": n, "title": h.titles[n], "body": "body", "state": "open", "labels": ls, "created_at": loopT0}
}

func (h *hub) open(n int, title string, labels ...string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.titles[n], h.labels[n] = title, labels
}

func (h *hub) post(n int, user, body string) int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextID++
	h.comments = append(h.comments, hubComment{ID: h.nextID, Issue: n, User: user, Body: body, At: loopT0.Add(time.Duration(h.nextID) * time.Second)})
	return h.nextID
}

func (h *hub) bodies(n int) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []string
	for _, c := range h.comments {
		if c.Issue == n {
			out = append(out, c.Body)
		}
	}
	return out
}

type loopClock struct{ t time.Time }

func (c *loopClock) Now() time.Time                       { return c.t }
func (c *loopClock) After(time.Duration) <-chan time.Time { return make(chan time.Time) }

type nopQueue struct{}

func (nopQueue) Enqueue(context.Context, api.TicketID, int) error { return nil }
func (nopQueue) Queued(context.Context) ([]mergeq.Entry, error)   { return nil, nil }
func (nopQueue) Run(context.Context) (mergeq.Report, error)       { return mergeq.Report{}, nil }

type loopRig struct {
	c    *core.Core
	h    *hub
	tr   *gh.Tracker
	obs  *porttest.Observer
	disp *porttest.Dispatcher
}

func newLoop(t *testing.T) *loopRig {
	t.Helper()
	h, tr := newHub(t)
	r := &loopRig{h: h, tr: tr, obs: porttest.NewObserver(), disp: porttest.NewDispatcher(2)}
	st, err := store.Open(filepath.Join(t.TempDir(), "s.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	clk := &loopClock{t: loopT0}
	r.c, err = core.New(core.Deps{Tracker: tr, Dispatcher: r.disp, Observer: r.obs, Store: st, Meter: meter.New(meter.Budgets{}, clk.Now), Queue: nopQueue{}, Clock: clk,
		OnError: func(err error) { t.Errorf("loop error: %v", err) }},
		core.Config{Reconcile: reconcile.Config{Tick: time.Second, MaxConcurrent: 2}})
	if err != nil {
		t.Fatal(err)
	}
	return r
}

// A `/factory retry` counts only from a trusted author, through the loop (chatops and trust).
func TestLoopRetryObeysTrustedAuthorsOnly(t *testing.T) {
	r := newLoop(t)
	r.h.open(7, "Add lease", "factory:ready")
	ctx := context.Background()
	r.c.Tick(ctx)
	if len(r.disp.Sessions) != 1 {
		t.Fatalf("first tick dispatched %v", r.disp.Sessions)
	}

	r.h.perms["stranger"] = "read"
	r.h.post(7, "stranger", "/factory retry")
	r.c.Tick(ctx)
	if len(r.disp.Sessions) != 1 || len(r.disp.Cancels) != 0 {
		t.Fatalf("untrusted retry changed something: sessions %v cancels %v", r.disp.Sessions, r.disp.Cancels)
	}
	for _, b := range r.h.bodies(7) {
		if strings.Contains(b, "factory:data") && strings.Contains(b, `"stage":"chatops"`) {
			t.Fatalf("untrusted command was acknowledged: %s", b)
		}
	}

	r.h.perms["maintainer"] = "write"
	r.h.post(7, "maintainer", "/factory retry")
	r.c.Tick(ctx)
	if _, ok := r.disp.Sessions["7-a2"]; !ok || len(r.disp.Cancels) != 1 {
		t.Fatalf("trusted retry did not start attempt 2: sessions %v cancels %v", r.disp.Sessions, r.disp.Cancels)
	}
	r.c.Tick(ctx)
	if len(r.disp.Sessions) != 2 {
		t.Fatalf("an acknowledged command ran again: %v", r.disp.Sessions)
	}
}

// Symphony 14: the thread alone restores the first dispatch time after the store is deleted, and a
// marker forged by an outsider restores nothing.
func TestThreadRebuildsStoreAfterDeletion(t *testing.T) {
	r := newLoop(t)
	r.h.open(7, "Add lease", "factory:ready")
	ctx := context.Background()
	r.c.Tick(ctx)
	r.obs.Set(api.Observation{Ticket: "7", Attempt: 1, Branch: "factory/7-a1", LastPush: loopT0})
	r.c.Tick(ctx) // first push seen: the loop writes the status marker
	r.h.perms["maintainer"] = "write"
	r.h.post(7, "maintainer", "/factory retry")

	rebuild := func() []store.TicketRow {
		st, err := store.Open(filepath.Join(t.TempDir(), "fresh.db"))
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = st.Close() }()
		if err := st.Rebuild(ctx, r.tr, r.obs); err != nil {
			t.Fatal(err)
		}
		rows, err := st.ReportRows(ctx)
		if err != nil {
			t.Fatal(err)
		}
		return rows
	}
	rows := rebuild()
	if len(rows) != 1 || !rows[0].FirstDispatch.Equal(loopT0) || rows[0].ChatopsCommands != 1 || !rows[0].MergedAt.IsZero() {
		t.Fatalf("rebuilt row %+v", rows)
	}
	if again := rebuild(); fmt.Sprint(again) != fmt.Sprint(rows) {
		t.Fatalf("two rebuilds differ:\n%v\n%v", rows, again)
	}

	forged := gh.EncodeData("Factory status: merged.", "status", json.RawMessage(`{"phase":"merged","merged_at":"2030-01-01T00:00:00Z"}`))
	r.h.post(7, "stranger", gh.StatusMarker+" -->\n"+forged)
	if rows := rebuild(); !rows[0].MergedAt.IsZero() {
		t.Fatalf("a forged status marker set MergedAt: %v", rows[0].MergedAt)
	}
}

var leakWord = regexp.MustCompile(`(?i)claude|opus|sonnet|haiku|token|\$\d|cost|usd|sk-ant`)

// #210: the PR the loop opens is rendered from the plan, the verdict and the pr text, and carries no
// model name, token count or cost, even when the thread's own text does.
func TestLoopOpensPRWithRenderedBody(t *testing.T) {
	r := newLoop(t)
	r.h.open(7, "Add lease", "factory:ready")
	marker := func(stage, js string) string { return gh.EncodeData("stage "+stage, stage, json.RawMessage(js)) }
	r.h.post(7, "bot", marker("plan", `{"goal":"Add the lease","acceptance":["lease is taken once"]}`))
	r.h.post(7, "bot", marker("verify", `{"proof":{"status":"bites","tests":["TestLease"],"reverted":["lease.go"]}}`))
	r.h.post(7, "bot", marker("pr", `{"body":"Adds the lease.\nBuilt with claude-opus-4-5, 12,345 tokens, cost: $3.20\nSee https://claude.ai/code/session_x"}`))
	r.h.post(7, "stranger", marker("pr", `{"body":"forged body"}`))
	ctx := context.Background()
	r.c.Tick(ctx)
	r.obs.Set(api.Observation{Ticket: "7", Attempt: 1, Branch: "factory/7-a1", LastPush: loopT0, HasReport: true, DiffFiles: []string{"lease.go", "lease_test.go"}})
	r.c.Tick(ctx)
	r.c.Tick(ctx)

	if len(r.h.pulls) != 1 {
		t.Fatalf("pull requests opened: %v", r.h.pulls)
	}
	pr := r.h.pulls[0]
	body, _ := pr["body"].(string)
	if pr["draft"] != true || pr["head"] != "factory/7-a1" || pr["base"] != "main" || pr["title"] != "Add lease" {
		t.Fatalf("pull request %v", pr)
	}
	for _, want := range []string{"## What changed\n\nAdd the lease", "`lease.go`, `lease_test.go`", "red with `lease.go` reverted", "Adds the lease.", "- [x] lease is taken once", "#7"} {
		if !strings.Contains(body, want) {
			t.Errorf("body lacks %q:\n%s", want, body)
		}
	}
	if m := leakWord.FindString(body); m != "" || strings.Contains(body, "forged") {
		t.Fatalf("body leaks %q or took a forged marker:\n%s", m, body)
	}
}
