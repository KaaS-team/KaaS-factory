package ghsource

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/observe"
	gogithub "github.com/google/go-github/v79/github"
)

// fake serves canned bodies by request path; the query string is matched by an optional "path?query" key first.
func fake(t *testing.T, routes map[string]func(w http.ResponseWriter, r *http.Request)) *Source {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if h, ok := routes[r.URL.Path+"?"+r.URL.RawQuery]; ok {
			h(w, r)
			return
		}
		if h, ok := routes[r.URL.Path]; ok {
			h(w, r)
			return
		}
		t.Errorf("unexpected request %s", r.URL.String())
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	c := gogithub.NewClient(srv.Client())
	u, _ := url.Parse(srv.URL + "/")
	c.BaseURL = u
	return New(c, "o", "r", "main")
}

func body(s string) func(http.ResponseWriter, *http.Request) {
	return func(w http.ResponseWriter, _ *http.Request) { _, _ = fmt.Fprint(w, s) }
}

var _ observe.Source = (*Source)(nil)

func TestBranch(t *testing.T) {
	when := time.Date(2026, 5, 1, 12, 0, 0, 0, time.UTC)
	tests := []struct {
		name   string
		route  func(http.ResponseWriter, *http.Request)
		exists bool
	}{
		{"present", body(`{"name":"b","commit":{"sha":"abc","commit":{"committer":{"date":"2026-05-01T12:00:00Z"}}}}`), true},
		{"missing", func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(404)
			_, _ = fmt.Fprint(w, `{"message":"Branch not found"}`)
		}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := fake(t, map[string]func(http.ResponseWriter, *http.Request){"/repos/o/r/branches/b": tc.route})
			got, exists, err := s.Branch(context.Background(), "b")
			if err != nil || exists != tc.exists {
				t.Fatalf("exists=%v err=%v", exists, err)
			}
			if exists && !got.Equal(when) {
				t.Fatalf("lastPush %v", got)
			}
		})
	}
}

func TestPullRequest(t *testing.T) {
	tests := []struct {
		name  string
		reply string
		found bool
		pr    observe.PR
	}{
		{"newest first wins", `[{"number":9,"state":"closed"},{"number":4,"state":"open"}]`, true, observe.PR{Number: 9, Open: false}},
		{"open", `[{"number":4,"state":"open"}]`, true, observe.PR{Number: 4, Open: true}},
		{"missing", `[]`, false, observe.PR{}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := fake(t, map[string]func(http.ResponseWriter, *http.Request){
				"/repos/o/r/pulls": func(w http.ResponseWriter, r *http.Request) {
					q := r.URL.Query()
					if q.Get("head") != "o:b" || q.Get("state") != "all" || q.Get("sort") != "created" || q.Get("direction") != "desc" {
						t.Errorf("query %v", q)
					}
					_, _ = fmt.Fprint(w, tc.reply)
				},
			})
			pr, found, err := s.PullRequest(context.Background(), "b")
			if err != nil || found != tc.found || pr != tc.pr {
				t.Fatalf("pr=%+v found=%v err=%v", pr, found, err)
			}
		})
	}
}

func TestDiffFilesTwoPages(t *testing.T) {
	var srvURL string
	s := fake(t, map[string]func(http.ResponseWriter, *http.Request){
		"/repos/o/r/compare/main...b": func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Query().Get("page") {
			case "", "1":
				w.Header().Set("Link", fmt.Sprintf(`<%s/repos/o/r/compare/main...b?page=2>; rel="next"`, srvURL))
				_, _ = fmt.Fprint(w, `{"files":[{"filename":"a.go"},{"filename":"b.go"}]}`)
			case "2":
				_, _ = fmt.Fprint(w, `{"files":[{"filename":"c.go"}]}`)
			default:
				t.Errorf("page %s", r.URL.Query().Get("page"))
			}
		},
	})
	srvURL = strings.TrimSuffix(s.client.BaseURL.String(), "/")
	got, err := s.DiffFiles(context.Background(), "b")
	if err != nil || strings.Join(got, ",") != "a.go,b.go,c.go" {
		t.Fatalf("got %v err %v", got, err)
	}
}

func TestChecksRollup(t *testing.T) {
	run := func(status, conclusion string) string {
		return fmt.Sprintf(`{"status":%q,"conclusion":%q}`, status, conclusion)
	}
	tests := []struct {
		name   string
		runs   []string
		legacy string
		want   observe.Checks
	}{
		{"all pass", []string{run("completed", "success"), run("completed", "skipped")}, `{"state":"success","total_count":1,"statuses":[{"state":"success"}]}`, observe.ChecksGreen},
		{"one pending", []string{run("completed", "success"), run("in_progress", "")}, `{"state":"success","total_count":0,"statuses":[]}`, observe.ChecksPending},
		{"one failed", []string{run("completed", "success"), run("completed", "failure")}, `{"state":"pending","total_count":0,"statuses":[]}`, observe.ChecksRed},
		{"legacy failure only", nil, `{"state":"failure","total_count":1,"statuses":[{"state":"failure"}]}`, observe.ChecksRed},
		{"legacy pending only", nil, `{"state":"pending","total_count":1,"statuses":[{"state":"pending"}]}`, observe.ChecksPending},
		{"nothing reported", nil, `{"state":"pending","total_count":0,"statuses":[]}`, observe.ChecksNone},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := fake(t, map[string]func(http.ResponseWriter, *http.Request){
				"/repos/o/r/pulls/7":                     body(`{"number":7,"head":{"sha":"deadbeef"}}`),
				"/repos/o/r/commits/deadbeef/check-runs": body(fmt.Sprintf(`{"total_count":%d,"check_runs":[%s]}`, len(tc.runs), strings.Join(tc.runs, ","))),
				"/repos/o/r/commits/deadbeef/status":     body(tc.legacy),
			})
			got, err := s.Checks(context.Background(), 7)
			if err != nil || got != tc.want {
				t.Fatalf("got %v err %v", got, err)
			}
		})
	}
}

func TestRateLimited(t *testing.T) {
	reset := time.Date(2026, 5, 1, 13, 0, 0, 0, time.UTC)
	s := fake(t, map[string]func(http.ResponseWriter, *http.Request){
		"/repos/o/r/branches/b": func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("X-RateLimit-Limit", "60")
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", fmt.Sprint(reset.Unix()))
			w.WriteHeader(403)
			_, _ = fmt.Fprint(w, `{"message":"API rate limit exceeded"}`)
		},
	})
	_, _, err := s.Branch(context.Background(), "b")
	var rl *RateLimitedError
	if !errors.As(err, &rl) || !rl.Reset.Equal(reset) {
		t.Fatalf("err %v", err)
	}
	if !strings.Contains(err.Error(), "2026-05-01T13:00:00Z") {
		t.Fatalf("message lacks reset: %v", err)
	}
}
