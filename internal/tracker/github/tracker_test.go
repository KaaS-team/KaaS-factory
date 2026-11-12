package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

var _ api.Tracker = (*gh.Tracker)(nil)

type req struct{ Method, Path, Query, Body string }

// fakeGitHub serves recorded goldens by "METHOD path" and logs every request.
type fakeGitHub struct {
	mu     sync.Mutex
	routes map[string]func(w http.ResponseWriter, r *http.Request)
	log    []req
	srv    *httptest.Server
}

func newFake(t *testing.T) *fakeGitHub {
	t.Helper()
	f := &fakeGitHub{routes: map[string]func(http.ResponseWriter, *http.Request){}}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.log = append(f.log, req{r.Method, r.URL.Path, r.URL.RawQuery, string(b)})
		f.mu.Unlock()
		h, ok := f.routes[r.Method+" "+r.URL.Path]
		if !ok {
			http.Error(w, fmt.Sprintf(`{"message":"unrouted %s %s"}`, r.Method, r.URL.Path), http.StatusTeapot)
			return
		}
		h(w, r)
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func golden(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func (f *fakeGitHub) serve(t *testing.T, route, file string, status int) {
	body := golden(t, file)
	f.routes[route] = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}
}

func (f *fakeGitHub) tracker(t *testing.T) *gh.Tracker {
	t.Helper()
	tr, err := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: f.srv.URL + "/", HTTPClient: f.srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func (f *fakeGitHub) requests() []req {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]req(nil), f.log...)
}

func TestNewRequiresRepo(t *testing.T) {
	if _, err := gh.New(gh.Config{Owner: "", Repo: "r"}); err == nil {
		t.Fatal("want an error for a missing owner")
	}
	if _, err := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: "::bad"}); err == nil {
		t.Fatal("want an error for a bad base URL")
	}
}

func TestName(t *testing.T) {
	if got := newFake(t).tracker(t).Name(); got != "github" {
		t.Fatalf("Name = %q", got)
	}
}

// Symphony §11: candidate issues come from the tracker, open and carrying the ready label.
func TestReadyListsOpenReadyIssuesAcrossPages(t *testing.T) {
	f := newFake(t)
	page1, page2 := golden(t, "issues_ready_page1.json"), golden(t, "issues_ready_page2.json")
	f.routes["GET /repos/o/r/issues"] = func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Query().Get("page") == "2" {
			_, _ = w.Write(page2)
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s/repos/o/r/issues?page=2>; rel="next"`, f.srv.URL))
		_, _ = w.Write(page1)
	}
	got, err := f.tracker(t).Ready(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ids []api.TicketID
	for _, tk := range got {
		ids = append(ids, tk.ID)
	}
	if want := []api.TicketID{"11", "14"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v, want %v (the pull request must be skipped)", ids, want)
	}
	if got[0].Title != "Add lease" || got[0].Body != "Body of 11" || got[0].Repo != "o/r" ||
		!reflect.DeepEqual(got[0].Labels, []string{"factory:ready", "feature"}) || got[0].CreatedAt.Year() != 2026 {
		t.Fatalf("ticket mapped wrong: %+v", got[0])
	}
	reqs := f.requests()
	if len(reqs) != 2 {
		t.Fatalf("requests = %d, want 2 pages", len(reqs))
	}
	q := reqs[0].Query
	for _, want := range []string{"labels=factory%3Aready", "state=open"} {
		if !strings.Contains(q, want) {
			t.Errorf("query %q lacks %q", q, want)
		}
	}
}

func TestReadyPropagatesAPIError(t *testing.T) {
	f := newFake(t)
	f.serve(t, "GET /repos/o/r/issues", "not_found.json", http.StatusNotFound)
	if _, err := f.tracker(t).Ready(context.Background()); err == nil {
		t.Fatal("want an error from a 404")
	}
}

func TestGet(t *testing.T) {
	f := newFake(t)
	f.serve(t, "GET /repos/o/r/issues/7", "issue_7.json", http.StatusOK)
	f.serve(t, "GET /repos/o/r/issues/8", "issue_8_pr.json", http.StatusOK)
	f.serve(t, "GET /repos/o/r/issues/99", "not_found.json", http.StatusNotFound)
	tr := f.tracker(t)

	tk, err := tr.Get(context.Background(), "7")
	if err != nil {
		t.Fatal(err)
	}
	if tk.ID != "7" || tk.Title != "Seven" || tk.Body != "Body of 7" || len(tk.Labels) != 5 {
		t.Fatalf("Get = %+v", tk)
	}
	if _, err := tr.Get(context.Background(), "8"); err == nil {
		t.Fatal("a pull request is not a ticket")
	}
	if _, err := tr.Get(context.Background(), "99"); err == nil {
		t.Fatal("want an error for a missing issue")
	}
	for _, bad := range []api.TicketID{"", "abc", "-1", "0", "7/../x"} {
		if _, err := tr.Get(context.Background(), bad); err == nil {
			t.Errorf("Get(%q) should be rejected before any request", bad)
		}
	}
	if n := len(f.requests()); n != 3 {
		t.Fatalf("requests = %d, want 3 (bad ids never reach the server)", n)
	}
}

func TestComment(t *testing.T) {
	f := newFake(t)
	f.serve(t, "POST /repos/o/r/issues/7/comments", "comment_created.json", http.StatusCreated)
	tr := f.tracker(t)
	body := "hello <!-- factory:status v1 -->"
	if err := tr.Comment(context.Background(), "7", body); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	var sent struct{ Body string }
	if err := json.Unmarshal([]byte(reqs[0].Body), &sent); err != nil || sent.Body != "hello" {
		t.Fatalf("sent %q (%v), want the marker dropped", reqs[0].Body, err)
	}
	if err := tr.Comment(context.Background(), "x", "b"); err == nil {
		t.Fatal("a bad id must be rejected")
	}
}

// SetPhase swaps the factory state label and never removes a label it does not own.
func TestSetPhase(t *testing.T) {
	cases := []struct {
		name    string
		issue   string
		phase   api.Phase
		removed []string // DELETE .../labels/<name>
		added   []string // labels in the POST body
	}{
		{"ready to running", "issue_7.json", api.PhaseRunning,
			[]string{"factory:needs-info", "factory:ready"}, []string{"factory:building"}},
		{"already in target phase", "issue_9_building.json", api.PhaseRunning, nil, nil},
		{"running to needs-human", "issue_9_building.json", api.PhaseNeedsHuman,
			[]string{"factory:building"}, []string{"factory:needs-human"}},
		{"merged clears owned labels and adds none", "issue_9_building.json", api.PhaseMerged,
			[]string{"factory:building"}, nil},
		{"canceled clears owned labels and adds none", "issue_7.json", api.PhaseCanceled,
			[]string{"factory:needs-info", "factory:ready"}, nil},
		{"queued is in review", "issue_9_building.json", api.PhaseQueued,
			[]string{"factory:building"}, []string{"factory:in-review"}},
		{"stalled keeps building", "issue_9_building.json", api.PhaseStalled, nil, nil},
		{"ready", "issue_9_building.json", api.PhaseReady,
			[]string{"factory:building"}, []string{"factory:ready"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := newFake(t)
			n := 7
			if tc.issue != "issue_7.json" {
				n = 9
			}
			f.serve(t, fmt.Sprintf("GET /repos/o/r/issues/%d", n), tc.issue, http.StatusOK)
			for _, l := range []string{"factory:ready", "factory:needs-info", "factory:building"} {
				f.routes[fmt.Sprintf("DELETE /repos/o/r/issues/%d/labels/%s", n, l)] = func(w http.ResponseWriter, _ *http.Request) {
					_, _ = w.Write(golden(t, "labels_after.json"))
				}
			}
			f.serve(t, fmt.Sprintf("POST /repos/o/r/issues/%d/labels", n), "labels_after.json", http.StatusOK)

			if err := f.tracker(t).SetPhase(context.Background(), api.TicketID(fmt.Sprint(n)), tc.phase); err != nil {
				t.Fatal(err)
			}
			var removed, added []string
			for _, r := range f.requests() {
				switch r.Method {
				case http.MethodDelete:
					removed = append(removed, r.Path[len(fmt.Sprintf("/repos/o/r/issues/%d/labels/", n)):])
				case http.MethodPost:
					var labels []string
					if err := json.Unmarshal([]byte(r.Body), &labels); err != nil {
						t.Fatalf("POST body %q: %v", r.Body, err)
					}
					added = append(added, labels...)
				}
			}
			sort.Strings(removed)
			if !reflect.DeepEqual(removed, tc.removed) || !reflect.DeepEqual(added, tc.added) {
				t.Fatalf("removed %v added %v; want removed %v added %v", removed, added, tc.removed, tc.added)
			}
			for _, r := range removed {
				if r == "bug" || r == "docs" || r == "customer:acme" || r == "factory:monitor" {
					t.Fatalf("removed a label the factory does not own: %s", r)
				}
			}
		})
	}
}

func TestSetPhaseUnknownPhase(t *testing.T) {
	f := newFake(t)
	if err := f.tracker(t).SetPhase(context.Background(), "7", api.Phase("bogus")); err == nil {
		t.Fatal("an unknown phase must be an error")
	}
	if len(f.requests()) != 0 {
		t.Fatal("an unknown phase must not reach the server")
	}
}

func TestOwnedLabels(t *testing.T) {
	for _, l := range []string{"factory:ready", "factory:blocked", "factory:overlap", "factory:triaging", "factory:planning",
		"factory:awaiting-approval", "factory:building", "factory:verifying", "factory:in-review",
		"factory:needs-info", "factory:needs-human", "factory:failed"} {
		if !gh.OwnsLabel(l) {
			t.Errorf("%s should be owned", l)
		}
	}
	for _, l := range []string{"bug", "feature", "factory:monitor", "factory:ledger", "customer:acme", ""} {
		if gh.OwnsLabel(l) {
			t.Errorf("%s must not be owned", l)
		}
	}
}

var _ api.Lister = (*gh.Tracker)(nil)

// Symphony §14: restart lists claimed, unfinished tickets in one query; ready, in-review and parked ones are not active.
func TestActiveListsBuildingAndVerifyingWithOneQuery(t *testing.T) {
	f := newFake(t)
	f.serve(t, "GET /repos/o/r/issues", "issues_active.json", http.StatusOK)
	got, err := f.tracker(t).Active(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var ids []api.TicketID
	for _, tk := range got {
		ids = append(ids, tk.ID)
	}
	if want := []api.TicketID{"21", "23"}; !reflect.DeepEqual(ids, want) {
		t.Fatalf("ids = %v, want %v", ids, want)
	}
	reqs := f.requests()
	if len(reqs) != 1 {
		t.Fatalf("requests = %d, want 1", len(reqs))
	}
	q, err := url.ParseQuery(reqs[0].Query)
	if err != nil {
		t.Fatal(err)
	}
	if gotReq, want := reqs[0].Method+" "+reqs[0].Path+"?"+q.Encode(), strings.TrimSpace(string(golden(t, "active_request.golden"))); gotReq != want {
		t.Fatalf("request = %q, golden %q", gotReq, want)
	}
}

func TestActivePropagatesAPIError(t *testing.T) {
	f := newFake(t)
	f.serve(t, "GET /repos/o/r/issues", "not_found.json", http.StatusNotFound)
	if _, err := f.tracker(t).Active(context.Background()); err == nil {
		t.Fatal("want an error from a 404")
	}
}
