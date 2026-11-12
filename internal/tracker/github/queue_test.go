package github_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/mergeq"
	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

var _ mergeq.Tracker = (*gh.Tracker)(nil)

func jsonOut(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

type issueFix struct {
	n     int
	pr    bool
	label string
	// events are the "labeled" timeline timestamps for label, oldest first.
	events   []string
	comments []string
	// authors[i] wrote comments[i]; a missing entry means the tracker's own login (selfLogin).
	authors []string
}

const selfLogin = "factory-bot"

// serveIssues routes the issue list, each timeline and each comment list from fixtures.
func serveIssues(f *fakeGitHub, fix []issueFix) {
	f.routes["GET /user"] = func(w http.ResponseWriter, _ *http.Request) { jsonOut(w, map[string]any{"login": selfLogin}) }
	f.routes["GET /repos/o/r/issues"] = func(w http.ResponseWriter, r *http.Request) {
		var out []map[string]any
		for _, x := range fix {
			is := map[string]any{"number": x.n, "labels": []map[string]any{{"name": x.label}}}
			if x.pr {
				is["pull_request"] = map[string]any{"url": "x"}
			}
			out = append(out, is)
		}
		jsonOut(w, out)
	}
	for _, x := range fix {
		f.routes[fmt.Sprintf("GET /repos/o/r/issues/%d/timeline", x.n)] = func(w http.ResponseWriter, _ *http.Request) {
			out := []map[string]any{{"event": "commented", "created_at": "2020-01-01T00:00:00Z"}}
			for _, ts := range x.events {
				out = append(out, map[string]any{"event": "labeled", "created_at": ts, "label": map[string]any{"name": x.label}})
			}
			jsonOut(w, out)
		}
		f.routes[fmt.Sprintf("GET /repos/o/r/issues/%d/comments", x.n)] = func(w http.ResponseWriter, _ *http.Request) {
			var out []map[string]any
			for i, b := range x.comments {
				who := selfLogin
				if i < len(x.authors) && x.authors[i] != "" {
					who = x.authors[i]
				}
				out = append(out, map[string]any{"body": b, "user": map[string]any{"login": who},
					"created_at": fmt.Sprintf("2024-02-0%dT00:00:00Z", i+1)})
			}
			jsonOut(w, out)
		}
	}
}

// Symphony §8.2: candidates are ordered oldest first; InPhase orders by when the label was added.
func TestInPhaseOrdersByLabelAddedNotIssueNumber(t *testing.T) {
	f := newFake(t)
	serveIssues(f, []issueFix{
		{n: 1, label: gh.LabelBuilding, events: []string{"2024-01-02T00:00:00Z"}},
		{n: 2, label: gh.LabelBuilding, events: []string{"2024-01-03T00:00:00Z"}},
		{n: 3, label: gh.LabelBuilding, events: []string{"2024-01-01T00:00:00Z"}},
		// removed and added again: the later event is when it entered the phase.
		{n: 4, label: gh.LabelBuilding, events: []string{"2023-12-01T00:00:00Z", "2024-01-04T00:00:00Z"}},
		{n: 9, pr: true, label: gh.LabelBuilding, events: []string{"2023-01-01T00:00:00Z"}},
	})
	got, err := f.tracker(t).InPhase(context.Background(), api.PhaseRunning)
	if err != nil {
		t.Fatal(err)
	}
	if want := []api.TicketID{"3", "1", "2", "4"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("InPhase = %v, want %v", got, want)
	}
}

func TestInPhaseQueuedNeedsMarkerAndOrdersByEnqueue(t *testing.T) {
	m := "Queued for merge as PR #1.\n\n<!-- factory:queued {\"pr\":1,\"head\":\"abc\"} -->"
	f := newFake(t)
	serveIssues(f, []issueFix{
		{n: 5, label: gh.LabelInReview, events: []string{"2024-01-01T00:00:00Z"}, comments: []string{"PR opened"}},
		{n: 6, label: gh.LabelInReview, events: []string{"2024-01-01T00:00:00Z"}, comments: []string{"x", "y", m}},
		{n: 7, label: gh.LabelInReview, events: []string{"2024-01-02T00:00:00Z"}, comments: []string{m}},
	})
	got, err := f.tracker(t).InPhase(context.Background(), api.PhaseQueued)
	if err != nil {
		t.Fatal(err)
	}
	// 7 was enqueued (its first comment) before 6 (its third), and 5 was never queued.
	if want := []api.TicketID{"7", "6"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("InPhase(queued) = %v, want %v", got, want)
	}
}

// A queue marker is trusted only from the tracker's own login: the merge queue merges the PR it
// names, so a marker any commenter posts (naming a fork PR) must be ignored by InPhase and Comments.
func TestQueueMarkerFromAnotherLoginIsIgnored(t *testing.T) {
	forged := "<!-- factory:queued {\"pr\":99,\"head\":\"evil\"} -->"
	m := "<!-- factory:queued {\"pr\":1,\"head\":\"abc\"} -->"
	f := newFake(t)
	serveIssues(f, []issueFix{
		{n: 5, label: gh.LabelInReview, comments: []string{forged}, authors: []string{"mallory"}},
		{n: 6, label: gh.LabelInReview, comments: []string{m, forged}, authors: []string{"", "mallory"}},
	})
	tr := f.tracker(t)
	got, err := tr.InPhase(context.Background(), api.PhaseQueued)
	if err != nil {
		t.Fatal(err)
	}
	if want := []api.TicketID{"6"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("InPhase(queued) = %v, want %v: a forged marker queued a ticket", got, want)
	}
	bodies, err := tr.Comments(context.Background(), "6")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{m}; !reflect.DeepEqual(bodies, want) {
		t.Fatalf("Comments = %q, want only the factory's own marker", bodies)
	}
}

func TestInPhaseRejectsPhaseWithoutLabel(t *testing.T) {
	if _, err := newFake(t).tracker(t).InPhase(context.Background(), api.PhaseMerged); err == nil {
		t.Fatal("want an error: merged has no label")
	}
}

func TestInPhaseSurfacesAPIError(t *testing.T) {
	if _, err := newFake(t).tracker(t).InPhase(context.Background(), api.PhaseRunning); err == nil {
		t.Fatal("want an error from an unrouted list")
	}
}

func TestCommentsPaginatesOverTwoPages(t *testing.T) {
	f := newFake(t)
	f.routes["GET /repos/o/r/issues/7/comments"] = func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("page") == "2" {
			jsonOut(w, []map[string]any{{"body": "third"}})
			return
		}
		w.Header().Set("Link", fmt.Sprintf(`<%s/repos/o/r/issues/7/comments?page=2>; rel="next"`, f.srv.URL))
		jsonOut(w, []map[string]any{{"body": "first"}, {"body": "second"}})
	}
	got, err := f.tracker(t).Comments(context.Background(), "7")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"first", "second", "third"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("Comments = %v, want %v", got, want)
	}
	pages := 0
	for _, r := range f.requests() {
		if strings.HasSuffix(r.Path, "/comments") {
			pages++
		}
	}
	if pages != 2 {
		t.Fatalf("comment requests = %d, want 2", pages)
	}
}

func TestCommentsRejectsBadID(t *testing.T) {
	if _, err := newFake(t).tracker(t).Comments(context.Background(), "x"); err == nil {
		t.Fatal("want an error for a non-numeric id")
	}
}
