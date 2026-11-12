package linear_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/tracker/linear"
	"github.com/KaaS-team/factory/internal/tracker/vendorkit"
)

var _ api.Tracker = (*linear.Tracker)(nil)

func newTracker(t *testing.T, f *fakeLinear, mut func(*linear.Config)) *linear.Tracker {
	t.Helper()
	cfg := linear.Config{
		Team: "ENG", TokenEnv: "LINEAR_TEST_TOKEN", BaseURL: f.srv.URL,
		ReadyState: "Ready",
		Phases: map[api.Phase]string{
			api.PhaseClaimed: "In Progress", api.PhaseDone: "In Review", api.PhaseMerged: "Done", api.PhaseReady: "Ready",
		},
		Getenv: func(k string) string {
			if k == "LINEAR_TEST_TOKEN" {
				return "test-token"
			}
			return ""
		},
		Client: &vendorkit.Client{Sleep: func(context.Context, time.Duration) error { return nil }, MaxRetries: 2},
	}
	if mut != nil {
		mut(&cfg)
	}
	tr, err := linear.New(cfg)
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

// Symphony §11: Ready is the candidate read; the configured state, label, or either.
func TestReady(t *testing.T) {
	cases := []struct {
		name  string
		mut   func(*linear.Config)
		want  []string
		check func(*testing.T, *fakeLinear)
	}{
		{"by state", nil, []string{"ENG-1"}, nil},
		{"by label", func(c *linear.Config) { c.ReadyState, c.ReadyLabel = "", "factory:ready" }, []string{"ENG-2"}, nil},
		{"state or label", func(c *linear.Config) { c.ReadyLabel = "factory:ready" }, []string{"ENG-1", "ENG-2"}, nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeLinear(t)
			f.add(1, "s-ready")
			f.add(2, "s-backlog", "factory:ready")
			f.add(3, "s-backlog")
			f.add(4, "s-done", "factory:ready")
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

func TestGetMapsTicket(t *testing.T) {
	f := newFakeLinear(t)
	i := f.add(42, "s-ready", "bug", "factory:ready")
	i.Title, i.Description = "Fix it", "Details"
	got, err := newTracker(t, f, nil).Get(context.Background(), "ENG-42")
	if err != nil {
		t.Fatal(err)
	}
	if got.ID != "ENG-42" || got.Title != "Fix it" || got.Body != "Details" || !reflect.DeepEqual(got.Labels, []string{"bug", "factory:ready"}) {
		t.Fatalf("ticket = %+v", got)
	}
	if got.CreatedAt.Format("2006-01-02T15:04:05Z") != "2026-01-02T03:04:05Z" {
		t.Fatalf("created = %v", got.CreatedAt)
	}
	if _, err := newTracker(t, f, nil).Get(context.Background(), "ENG-99"); err == nil || !strings.Contains(err.Error(), "ENG-99") {
		t.Fatalf("missing issue err = %v", err)
	}
}

// The request bodies the TS adapter sends, recorded by running it (testdata/ts-*.json).
func TestRequestBodiesMatchTS(t *testing.T) {
	f := newFakeLinear(t)
	f.add(42, "s-ready", "factory:ready")
	tr := newTracker(t, f, func(c *linear.Config) { c.ReadyState, c.ReadyLabel = "", "factory:ready" })
	ctx := context.Background()
	if _, err := tr.Ready(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := tr.Get(ctx, "ENG-42"); err != nil {
		t.Fatal(err)
	}
	if err := tr.Comment(ctx, "ENG-42", "hello"); err != nil {
		t.Fatal(err)
	}
	// Go sends Issue (get), Issue (comment lookup), CommentCreate, in the same order as TS.
	want := []struct{ op, file string }{
		{"Issues", "ts-Issues-0.json"}, {"Issue", "ts-Issue-0.json"}, {"Issue", "ts-Issue-1.json"}, {"CommentCreate", "ts-CommentCreate-0.json"},
	}
	if len(f.Requests) != len(want) {
		t.Fatalf("ops = %v", f.ops())
	}
	for n, w := range want {
		raw, err := os.ReadFile("testdata/" + w.file)
		if err != nil {
			t.Fatal(err)
		}
		var golden map[string]any
		if err := json.Unmarshal(raw, &golden); err != nil {
			t.Fatal(err)
		}
		if f.Requests[n].Op != w.op || !reflect.DeepEqual(f.Requests[n].Body, golden) {
			t.Errorf("request %d (%s) differs from %s:\n got %v\nwant %v", n, f.Requests[n].Op, w.file, f.Requests[n].Body, golden)
		}
	}
}

func TestCommentCarriesMarkers(t *testing.T) {
	f := newFakeLinear(t)
	i := f.add(1, "s-ready")
	body := "plan ready\n<!-- factory:plan -->\n"
	if err := newTracker(t, f, nil).Comment(context.Background(), "ENG-1", body); err != nil {
		t.Fatal(err)
	}
	stored := i.Comments[0]["body"].(string)
	if strings.Contains(stored, "<!--") || !strings.Contains(stored, "factory-data: ") || !strings.HasPrefix(stored, "plan ready\n\nfactory-data: ") {
		t.Fatalf("stored = %q", stored)
	}
	want := vendorkit.EncodeBody(body, vendorkit.HMACSeal("test-token"), "comment")
	if stored != want {
		t.Fatalf("stored = %q, want %q", stored, want)
	}
}

func TestSetPhase(t *testing.T) {
	cases := []struct {
		name      string
		phase     api.Phase
		start     string
		wantState string
		wantErr   string
		wantOps   []string
	}{
		{"mapped phase moves the ticket", api.PhaseClaimed, "s-ready", "s-progress", "", []string{"IssueState", "Team", "IssueUpdate"}},
		{"ready state is owned", api.PhaseClaimed, "s-ready", "s-progress", "", nil},
		{"already there is a no-op", api.PhaseClaimed, "s-progress", "s-progress", "", []string{"IssueState"}},
		{"unmapped phase names the phase", api.PhaseStalled, "s-ready", "s-ready", `"stalled"`, []string{}},
		{"unowned current state is refused", api.PhaseClaimed, "s-backlog", "s-backlog", `"Backlog"`, []string{"IssueState"}},
		{"mapped name the team lacks", api.PhaseQueued, "s-ready", "s-ready", `"Queued"`, []string{"IssueState", "Team"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			f := newFakeLinear(t)
			i := f.add(1, c.start)
			tr := newTracker(t, f, func(cfg *linear.Config) { cfg.Phases[api.PhaseQueued] = "Queued" })
			err := tr.SetPhase(context.Background(), "ENG-1", c.phase)
			if c.wantErr == "" && err != nil || c.wantErr != "" && (err == nil || !strings.Contains(err.Error(), c.wantErr)) {
				t.Fatalf("err = %v, want containing %q", err, c.wantErr)
			}
			if i.State != c.wantState {
				t.Fatalf("state = %s, want %s", i.State, c.wantState)
			}
			if c.wantOps != nil && !reflect.DeepEqual(append([]string{}, f.ops()...), c.wantOps) && !(len(c.wantOps) == 0 && len(f.ops()) == 0) {
				t.Fatalf("ops = %v, want %v", f.ops(), c.wantOps)
			}
		})
	}
}

func TestSetPhaseSendsStateID(t *testing.T) {
	f := newFakeLinear(t)
	f.add(1, "s-ready")
	if err := newTracker(t, f, nil).SetPhase(context.Background(), "ENG-1", api.PhaseDone); err != nil {
		t.Fatal(err)
	}
	last := f.Requests[len(f.Requests)-1]
	vars := last.Body["variables"].(map[string]any)
	if last.Op != "IssueUpdate" || vars["id"] != "uuid-1" || !reflect.DeepEqual(vars["input"], map[string]any{"stateId": "s-review"}) {
		t.Fatalf("update = %v", last.Body)
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
			f := newFakeLinear(t)
			f.add(1, "s-ready")
			f.Fail = c.fail
			_, err := newTracker(t, f, nil).Get(context.Background(), "ENG-1")
			if (err != nil) != c.wantErr || len(f.Requests) != c.wantReqs {
				t.Fatalf("err = %v, requests = %d, want err=%v requests=%d", err, len(f.Requests), c.wantErr, c.wantReqs)
			}
			var se *vendorkit.StatusError
			if c.wantErr && (!errors.As(err, &se) || se.Status != 403) {
				t.Fatalf("err = %v, want a 403 StatusError", err)
			}
		})
	}
}

func TestAuthAndConfig(t *testing.T) {
	f := newFakeLinear(t)
	f.add(1, "s-ready")
	if _, err := newTracker(t, f, nil).Get(context.Background(), "ENG-1"); err != nil {
		t.Fatal(err)
	}
	if f.Requests[0].Auth != "test-token" {
		t.Fatalf("auth = %q", f.Requests[0].Auth)
	}
	for name, mut := range map[string]func(*linear.Config){
		"no team":      func(c *linear.Config) { c.Team = "" },
		"no token env": func(c *linear.Config) { c.TokenEnv = "" },
		"no ready":     func(c *linear.Config) { c.ReadyState = "" },
	} {
		cfg := linear.Config{Team: "ENG", TokenEnv: "X", ReadyState: "Ready"}
		mut(&cfg)
		if _, err := linear.New(cfg); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
	tr := newTracker(t, f, func(c *linear.Config) { c.Getenv = func(string) string { return "" } })
	if _, err := tr.Get(context.Background(), "ENG-1"); err == nil || !strings.Contains(err.Error(), "LINEAR_TEST_TOKEN") {
		t.Fatalf("unset token err = %v", err)
	}
}
