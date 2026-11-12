package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/plancmd"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

var (
	_ plancmd.Filer    = (*gh.Tracker)(nil)
	_ plancmd.EpicFunc = gh.Epic(nil)
)

// fakeIssues is a tiny GitHub that stores created issues and answers title searches (Symphony §11:
// the tracker is the system of record, so the filer's only memory is the issue list).
type fakeIssues struct {
	mu     sync.Mutex
	issues []map[string]any
	posts  []map[string]any
	srv    *httptest.Server
}

func newIssues(t *testing.T) *fakeIssues {
	t.Helper()
	f := &fakeIssues{}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /search/issues", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		q := r.URL.Query().Get("q")
		items := []map[string]any{}
		for _, is := range f.issues {
			// A loose search: any issue whose title contains the quoted phrase, like the real index.
			if strings.Contains(strings.ToLower(is["title"].(string)), strings.ToLower(quoted(q))) {
				items = append(items, is)
			}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"total_count": len(items), "items": items})
	})
	mux.HandleFunc("POST /repos/o/r/issues", func(w http.ResponseWriter, r *http.Request) {
		var in map[string]any
		_ = json.NewDecoder(r.Body).Decode(&in)
		f.mu.Lock()
		defer f.mu.Unlock()
		f.posts = append(f.posts, in)
		stored := map[string]any{"number": len(f.issues) + 1, "title": in["title"], "body": in["body"]}
		f.issues = append(f.issues, stored)
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(stored)
	})
	mux.HandleFunc("GET /repos/o/r/issues/{n}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		for _, is := range f.issues {
			if fmt.Sprint(is["number"]) == r.PathValue("n") {
				_ = json.NewEncoder(w).Encode(is)
				return
			}
		}
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"message":"Not Found"}`))
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func quoted(q string) string {
	i := strings.Index(q, `"`)
	j := strings.LastIndex(q, `"`)
	if i < 0 || j <= i {
		return q
	}
	return q[i+1 : j]
}

func (f *fakeIssues) tracker(t *testing.T) *gh.Tracker {
	t.Helper()
	tr, err := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: f.srv.URL + "/", HTTPClient: f.srv.Client()})
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func TestCreatePostsPlannedBodyByteForByte(t *testing.T) {
	want, err := os.ReadFile("../../plan/testdata/planned-issue.md")
	if err != nil {
		t.Fatal(err)
	}
	f := newIssues(t)
	id, err := f.tracker(t).Create(context.Background(), api.Ticket{
		Title: "Resume at the failed stage", Body: string(want), Labels: []string{gh.LabelReady},
	})
	if err != nil {
		t.Fatal(err)
	}
	if id != "1" {
		t.Fatalf("id = %q", id)
	}
	if got := f.posts[0]["body"]; got != string(want) {
		t.Fatalf("body differs from the plan golden:\n%q\n%q", got, string(want))
	}
	if got := fmt.Sprint(f.posts[0]["labels"]); got != "[factory:ready]" {
		t.Fatalf("labels = %s", got)
	}
}

func TestCreateDefaultsToReadyLabel(t *testing.T) {
	f := newIssues(t)
	if _, err := f.tracker(t).Create(context.Background(), api.Ticket{Title: "a", Body: "b"}); err != nil {
		t.Fatal(err)
	}
	if got := fmt.Sprint(f.posts[0]["labels"]); got != "[factory:ready]" {
		t.Fatalf("labels = %s", got)
	}
}

func TestFindExactVersusNearMatch(t *testing.T) {
	f := newIssues(t)
	tr := f.tracker(t)
	ctx := context.Background()
	if _, err := tr.Create(ctx, api.Ticket{Title: "Add the lease", Body: "x"}); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		title string
		want  bool
	}{
		{"Add the lease", true},
		{"Add the lease table", false}, // the search matches it, the exact compare refuses
		{"add the lease", false},
		{"Add the", false},
	} {
		id, ok, err := tr.Find(ctx, tc.title)
		if err != nil || ok != tc.want || (ok && id != "1") {
			t.Errorf("Find(%q) = %q %v %v, want %v", tc.title, id, ok, err, tc.want)
		}
	}
}

func TestFindSkipsPullRequests(t *testing.T) {
	f := newIssues(t)
	f.issues = append(f.issues, map[string]any{"number": 5, "title": "T", "pull_request": map[string]any{}})
	if _, ok, err := f.tracker(t).Find(context.Background(), "T"); err != nil || ok {
		t.Fatalf("Find over a PR = %v %v", ok, err)
	}
}

func TestCreateIsIdempotentByTitle(t *testing.T) {
	f := newIssues(t)
	tr := f.tracker(t)
	ctx := context.Background()
	a, err := tr.Create(ctx, api.Ticket{Title: "T", Body: "b"})
	if err != nil {
		t.Fatal(err)
	}
	b, err := tr.Create(ctx, api.Ticket{Title: "T", Body: "b"})
	if err != nil || a != b || len(f.posts) != 1 {
		t.Fatalf("second Create = %q %v, posts %d", b, err, len(f.posts))
	}
}

func TestCreateIdempotentWhenSearchLags(t *testing.T) {
	f := newIssues(t)
	// A fresh server so the handler swap is race free.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/search/issues" {
			_, _ = w.Write([]byte(`{"total_count":0,"items":[]}`))
			return
		}
		f.mu.Lock()
		f.posts = append(f.posts, nil)
		n := len(f.posts)
		f.mu.Unlock()
		w.WriteHeader(http.StatusCreated)
		_, _ = fmt.Fprintf(w, `{"number":%d}`, n)
	}))
	t.Cleanup(srv.Close)
	tr, _ := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: srv.URL + "/", HTTPClient: srv.Client()})
	a, _ := tr.Create(context.Background(), api.Ticket{Title: "T"})
	b, _ := tr.Create(context.Background(), api.Ticket{Title: "T"})
	if a != b || len(f.posts) != 1 {
		t.Fatalf("a=%q b=%q posts=%d", a, b, len(f.posts))
	}
}

func TestFilingTheSameDAGTwiceCreatesNothingTheSecondTime(t *testing.T) {
	f := newIssues(t)
	tr := f.tracker(t)
	ctx := context.Background()
	file := func() {
		for _, title := range []string{"one", "two", "three"} {
			id, ok, err := tr.Find(ctx, title)
			if err != nil {
				t.Fatal(err)
			}
			if !ok {
				if id, err = tr.Create(ctx, api.Ticket{Title: title, Body: "b"}); err != nil {
					t.Fatal(err)
				}
			}
			_ = id
		}
	}
	file()
	first := len(f.posts)
	file()
	if first != 3 || len(f.posts) != 3 {
		t.Fatalf("posts after first %d, after second %d", first, len(f.posts))
	}
}

func TestCreateErrors(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"message":"boom"}`, http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	tr, _ := gh.New(gh.Config{Owner: "o", Repo: "r", BaseURL: srv.URL + "/", HTTPClient: srv.Client()})
	if _, _, err := tr.Find(context.Background(), "T"); err == nil {
		t.Fatal("Find: want error")
	}
	if _, err := tr.Create(context.Background(), api.Ticket{Title: "T"}); err == nil {
		t.Fatal("Create: want error")
	}
	if _, err := tr.Create(context.Background(), api.Ticket{}); err == nil {
		t.Fatal("empty title: want error")
	}
}

func TestEpicReturnsBodyAndNamesMissingIssue(t *testing.T) {
	f := newIssues(t)
	f.issues = append(f.issues, map[string]any{"number": 1, "title": "epic", "body": "the epic body"})
	epic := gh.Epic(f.tracker(t))
	got, err := epic(context.Background(), 1)
	if err != nil || got != "the epic body" {
		t.Fatalf("Epic(1) = %q %v", got, err)
	}
	_, err = epic(context.Background(), 99)
	if err == nil || !strings.Contains(err.Error(), "epic #99") || !strings.Contains(err.Error(), "not found") {
		t.Fatalf("missing epic error = %v", err)
	}
	if _, err := epic(context.Background(), 0); err == nil {
		t.Fatal("epic 0: want error")
	}
}
