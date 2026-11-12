package jira_test

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/tracker/jira"
	"github.com/KaaS-team/factory/internal/tracker/vendorkit"
)

var _ api.Tracker = (*jira.Tracker)(nil)

func newTracker(t *testing.T, f *fakeJira, mut func(*jira.Config)) *jira.Tracker {
	t.Helper()
	cfg := jira.Config{
		BaseURL: f.srv.URL, Project: "SHOP", TokenEnv: "JIRA_TEST_TOKEN", ReadyStatus: "Ready",
		Phases: map[api.Phase]string{
			api.PhaseReady: "Ready", api.PhaseClaimed: "In Progress", api.PhaseDone: "In Review", api.PhaseMerged: "Done",
		},
		Getenv: func(k string) string {
			if k == "JIRA_TEST_TOKEN" {
				return "me@example.com:test-token"
			}
			return ""
		},
		Client: &vendorkit.Client{Sleep: func(context.Context, time.Duration) error { return nil }, MaxRetries: 2},
	}
	if mut != nil {
		mut(&cfg)
	}
	tr, err := jira.New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	return tr
}

func ids(ts []api.Ticket) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, string(t.ID))
	}
	return out
}

// Symphony §11: Ready is the candidate read; the configured status, label, or either.
func TestReady(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*jira.Config)
		want []string
	}{
		{"by status", nil, []string{"SHOP-1"}},
		{"by label", func(c *jira.Config) { c.ReadyStatus, c.ReadyLabel = "", "factory:ready" }, []string{"SHOP-2"}},
		{"status or label", func(c *jira.Config) { c.ReadyLabel = "factory:ready" }, []string{"SHOP-1", "SHOP-2"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeJira(t)
			f.add(1, "Ready")
			f.add(2, "To Do", "factory:ready")
			f.add(3, "To Do")
			f.add(4, "Done", "factory:ready")
			got, err := newTracker(t, f, c.mut).Ready(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(ids(got), c.want) {
				t.Fatalf("got %v, want %v", ids(got), c.want)
			}
		})
	}
}

func TestReadySendsJQLAndAuth(t *testing.T) {
	f := newFakeJira(t)
	if _, err := newTracker(t, f, func(c *jira.Config) { c.ReadyLabel = "a\"b" }).Ready(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := f.Requests[0]
	want := `project = "SHOP" AND statusCategory != Done AND (status = "Ready" OR labels = "a\"b") ORDER BY created ASC`
	if r.Method != "POST" || r.Path != "/rest/api/3/search/jql" || r.Body["jql"] != want {
		t.Fatalf("request = %+v", r)
	}
	if r.Auth != "Basic bWVAZXhhbXBsZS5jb206dGVzdC10b2tlbg==" {
		t.Fatalf("auth = %q", r.Auth)
	}
}

func TestGetMapsTicket(t *testing.T) {
	f := newFakeJira(t)
	i := f.add(42, "Ready", "bug")
	i.Summary = "Fix it"
	i.Description = map[string]any{"type": "doc", "version": 1, "content": []any{
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "line one"}, map[string]any{"type": "hardBreak"}, map[string]any{"type": "text", "text": "line two"}}},
		map[string]any{"type": "paragraph", "content": []any{map[string]any{"type": "text", "text": "para two"}}},
	}}
	tr := newTracker(t, f, nil)
	got, err := tr.Get(context.Background(), "SHOP-42")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "SHOP-42" || got.Title != "Fix it" || got.Body != "line one\nline two\npara two" || !reflect.DeepEqual(got.Labels, []string{"bug"}) {
		t.Fatalf("ticket = %+v", got)
	}
	if got.CreatedAt.UTC().Format(time.RFC3339) != "2026-01-02T03:04:05Z" {
		t.Fatalf("created = %v", got.CreatedAt)
	}
	for _, id := range []api.TicketID{"SHOP-99", "../myself", "OTHER-1"} {
		if _, err := tr.Get(context.Background(), id); err == nil {
			t.Errorf("Get(%q) want error", id)
		}
	}
}

func TestGetNullDescription(t *testing.T) {
	f := newFakeJira(t)
	f.add(1, "Ready").Description = nil
	got, err := newTracker(t, f, nil).Get(context.Background(), "SHOP-1")
	if err != nil || got.Body != "" {
		t.Fatalf("%+v %v", got, err)
	}
}

func TestCommentSendsADF(t *testing.T) {
	f := newFakeJira(t)
	i := f.add(1, "Ready")
	if err := newTracker(t, f, nil).Comment(context.Background(), "SHOP-1", "one\n\ntwo"); err != nil {
		t.Fatal(err)
	}
	r := f.Requests[0]
	if r.Method != "POST" || r.Path != "/rest/api/3/issue/SHOP-1/comment" || !reflect.DeepEqual(r.Body["body"], viaJSON(adf("one", "", "two"))) {
		t.Fatalf("request = %+v", r)
	}
	if len(i.Comments) != 1 {
		t.Fatal("comment not stored")
	}
}

func TestCommentCarriesMarkers(t *testing.T) {
	f := newFakeJira(t)
	i := f.add(1, "Ready")
	body := "plan ready\n<!-- factory:plan -->\n"
	if err := newTracker(t, f, nil).Comment(context.Background(), "SHOP-1", body); err != nil {
		t.Fatal(err)
	}
	want := vendorkit.EncodeBody(body, vendorkit.HMACSeal("me@example.com:test-token"), "comment")
	var got []string
	for _, p := range i.Comments[0]["body"].(map[string]any)["content"].([]any) {
		if c, ok := p.(map[string]any)["content"].([]any); ok {
			got = append(got, c[0].(map[string]any)["text"].(string))
		}
	}
	if strings.Join(got, "\n") != strings.ReplaceAll(want, "\n\n", "\n") || !strings.Contains(want, "factory-data: ") {
		t.Fatalf("stored %q, want footer form of %q", got, want)
	}
}

func TestSetPhase(t *testing.T) {
	cases := []struct {
		name, start, want, wantErr string
		phase                      api.Phase
		wantCalls                  []string
	}{
		{"mapped phase transitions", "Ready", "In Progress", "", api.PhaseClaimed,
			[]string{"GET /rest/api/3/issue/SHOP-1", "GET /rest/api/3/issue/SHOP-1/transitions", "POST /rest/api/3/issue/SHOP-1/transitions"}},
		{"already there is a no-op", "In Progress", "In Progress", "", api.PhaseClaimed, []string{"GET /rest/api/3/issue/SHOP-1"}},
		{"unmapped phase names the phase", "Ready", "Ready", `"stalled"`, api.PhaseStalled, nil},
		{"unowned current status is refused", "To Do", "To Do", `"To Do"`, api.PhaseClaimed, []string{"GET /rest/api/3/issue/SHOP-1"}},
		{"mapped status with no transition", "Ready", "Ready", `"Queued"`, api.PhaseQueued,
			[]string{"GET /rest/api/3/issue/SHOP-1", "GET /rest/api/3/issue/SHOP-1/transitions"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeJira(t)
			i := f.add(1, c.start)
			tr := newTracker(t, f, func(cfg *jira.Config) { cfg.Phases[api.PhaseQueued] = "Queued" })
			err := tr.SetPhase(context.Background(), "SHOP-1", c.phase)
			if c.wantErr == "" && err != nil || c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, c.wantErr)
			}
			if i.Status != c.want {
				t.Fatalf("status = %s, want %s", i.Status, c.want)
			}
			if len(f.calls()) != len(c.wantCalls) || (len(c.wantCalls) > 0 && !reflect.DeepEqual(f.calls(), c.wantCalls)) {
				t.Fatalf("calls = %v, want %v", f.calls(), c.wantCalls)
			}
		})
	}
}

func TestSetPhaseSendsTransitionID(t *testing.T) {
	f := newFakeJira(t)
	f.add(1, "Ready")
	if err := newTracker(t, f, nil).SetPhase(context.Background(), "SHOP-1", api.PhaseMerged); err != nil {
		t.Fatal(err)
	}
	last := f.Requests[len(f.Requests)-1]
	if !reflect.DeepEqual(last.Body, map[string]any{"transition": map[string]any{"id": "15"}}) {
		t.Fatalf("body = %v", last.Body)
	}
}

func TestRetries(t *testing.T) {
	cases := []struct {
		name     string
		fail     []int
		wantReqs int
		wantErr  bool
	}{
		{"429 then 200 retries once", []int{429}, 2, false},
		{"403 does not retry", []int{403}, 1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeJira(t)
			f.add(1, "Ready")
			f.Fail = c.fail
			_, err := newTracker(t, f, nil).Get(context.Background(), "SHOP-1")
			if (err != nil) != c.wantErr || len(f.Requests) != c.wantReqs {
				t.Fatalf("err = %v, requests = %d", err, len(f.Requests))
			}
			var se *vendorkit.StatusError
			if c.wantErr && (!errors.As(err, &se) || se.Status != 403) {
				t.Fatalf("err = %v, want a 403 StatusError", err)
			}
		})
	}
}

func TestAuthSchemeAndConfig(t *testing.T) {
	f := newFakeJira(t)
	f.add(1, "Ready")
	f.Token = "pat-without-colon"
	tr := newTracker(t, f, func(c *jira.Config) {
		c.Getenv = func(string) string { return "pat-without-colon" }
	})
	// The fake only takes Basic, so a Bearer token is refused: the scheme is what is under test.
	_, _ = tr.Get(context.Background(), "SHOP-1")
	if f.Requests[0].Auth != "Bearer pat-without-colon" {
		t.Fatalf("auth = %q", f.Requests[0].Auth)
	}
	for name, mut := range map[string]func(*jira.Config){
		"no url":     func(c *jira.Config) { c.BaseURL = "" },
		"no project": func(c *jira.Config) { c.Project = "" },
		"no token":   func(c *jira.Config) { c.TokenEnv = "" },
		"no ready":   func(c *jira.Config) { c.ReadyStatus = "" },
	} {
		cfg := jira.Config{BaseURL: "http://x", Project: "SHOP", TokenEnv: "X", ReadyStatus: "Ready"}
		mut(&cfg)
		if _, err := jira.New(cfg); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	unset := newTracker(t, f, func(c *jira.Config) { c.Getenv = func(string) string { return "" } })
	if _, err := unset.Get(context.Background(), "SHOP-1"); err == nil || !strings.Contains(err.Error(), "JIRA_TEST_TOKEN") {
		t.Fatalf("unset token err = %v", err)
	}
}

func viaJSON(v map[string]any) map[string]any {
	b, _ := json.Marshal(v)
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	return out
}

var _ api.Lister = (*jira.Tracker)(nil)

// Symphony §14: Active is the restart read, tickets claimed and not finished, in one search.
func TestActive(t *testing.T) {
	cases := []struct {
		name string
		mut  func(*jira.Config)
		want []string
	}{
		{"claimed status only", nil, []string{"SHOP-2"}},
		{"another active phase adds its status", func(c *jira.Config) {
			c.Phases[api.PhaseStalled] = "To Do"
		}, []string{"SHOP-2", "SHOP-5"}},
		{"a status shared with a finished phase is not active", func(c *jira.Config) {
			c.Phases[api.PhaseQueued] = "In Review"
		}, []string{"SHOP-2"}},
		{"no active phase mapped", func(c *jira.Config) {
			c.Phases = map[api.Phase]string{api.PhaseReady: "Ready", api.PhaseDone: "In Review"}
		}, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeJira(t)
			f.add(1, "Ready")
			f.add(2, "In Progress")
			f.add(3, "In Review")
			f.add(4, "Done")
			f.add(5, "To Do")
			got, err := newTracker(t, f, c.mut).Active(context.Background())
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(ids(got), c.want) {
				t.Fatalf("got %v, want %v", ids(got), c.want)
			}
			if len(c.want) == 0 && len(f.Requests) != 0 {
				t.Fatalf("no active status should make no request, got %v", f.calls())
			}
		})
	}
}

func TestActiveSendsJQL(t *testing.T) {
	f := newFakeJira(t)
	if _, err := newTracker(t, f, func(c *jira.Config) {
		c.Phases[api.PhaseRunning] = `Work "x"`
	}).Active(context.Background()); err != nil {
		t.Fatal(err)
	}
	r := f.Requests[0]
	want := `project = "SHOP" AND statusCategory != Done AND status in ("In Progress", "Work \"x\"") ORDER BY created ASC`
	if len(f.Requests) != 1 || r.Method != "POST" || r.Path != "/rest/api/3/search/jql" || r.Body["jql"] != want {
		t.Fatalf("requests = %+v", f.Requests)
	}
	wantBody := map[string]any{"jql": want, "fields": []any{"summary", "description", "labels", "status", "created"}, "maxResults": float64(100)}
	if !reflect.DeepEqual(r.Body, wantBody) {
		t.Fatalf("body = %v, want %v", r.Body, wantBody)
	}
}
