package github_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/marker"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/observe"
)

// The ledger edits the tracker's own spend comment in place and ignores one a stranger wrote.
func TestSpendCommentEditsOwnNotStrangers(t *testing.T) {
	forged := meter.EncodeSpend(meter.Spend{Holder: "x", Runs: 1})
	own := meter.EncodeSpend(meter.Spend{Holder: "alpha", Runs: 1})
	for _, c := range []struct {
		name     string
		comments []string
		authors  []string
		want     string // method and path of the write
	}{
		{"none yet", []string{"hello"}, nil, "POST /repos/o/r/issues/5/comments"},
		{"stranger only", []string{forged}, []string{"mallory"}, "POST /repos/o/r/issues/5/comments"},
		{"own", []string{"hello", own}, nil, "PATCH /repos/o/r/issues/comments/0"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFake(t)
			serveIssues(f, []issueFix{{n: 5, comments: c.comments, authors: c.authors}})
			f.routes["POST /repos/o/r/issues/5/comments"] = func(w http.ResponseWriter, _ *http.Request) { jsonOut(w, map[string]any{}) }
			f.routes["PATCH /repos/o/r/issues/comments/0"] = func(w http.ResponseWriter, _ *http.Request) { jsonOut(w, map[string]any{}) }
			tr := f.tracker(t)
			ctx := context.Background()
			got, err := tr.SpendComment(ctx, "5")
			if err != nil || (c.name == "own") != (got == own) {
				t.Fatalf("SpendComment = %q, %v", got, err)
			}
			if err := tr.PutSpendComment(ctx, "5", own); err != nil {
				t.Fatal(err)
			}
			last := f.log[len(f.log)-1]
			if got := last.Method + " " + last.Path; got != c.want || !strings.Contains(last.Body, "factory:spend") {
				t.Fatalf("write = %s %s, want %s", got, last.Body, c.want)
			}
		})
	}
}

// The workflow position lives in one comment of the tracker's own, edited in place; a stranger's is ignored.
func TestPositionCommentEditsOwnNotStrangers(t *testing.T) {
	pos := observe.Position{Node: "build", Base: 1, PR: 3}
	forged := marker.EncodePosition("Factory position: build.", observe.Position{Node: "forged"})
	own := marker.EncodePosition("Factory position: build.", pos)
	for _, c := range []struct {
		name     string
		comments []string
		authors  []string
		found    string
		want     string // method and path of the write
	}{
		{"none yet", []string{"hello"}, nil, "", "POST /repos/o/r/issues/5/comments"},
		{"stranger only", []string{forged}, []string{"mallory"}, "", "POST /repos/o/r/issues/5/comments"},
		{"own", []string{"hello", own}, nil, "build", "PATCH /repos/o/r/issues/comments/0"},
	} {
		t.Run(c.name, func(t *testing.T) {
			f := newFake(t)
			serveIssues(f, []issueFix{{n: 5, comments: c.comments, authors: c.authors}})
			f.routes["POST /repos/o/r/issues/5/comments"] = func(w http.ResponseWriter, _ *http.Request) { jsonOut(w, map[string]any{}) }
			f.routes["PATCH /repos/o/r/issues/comments/0"] = func(w http.ResponseWriter, _ *http.Request) { jsonOut(w, map[string]any{}) }
			tr := f.tracker(t)
			ctx := context.Background()
			got, ok, err := tr.LoadPosition(ctx, "5")
			if err != nil || got.Node != c.found || ok != (c.found != "") {
				t.Fatalf("LoadPosition = %+v, %v, %v", got, ok, err)
			}
			if err := tr.SavePosition(ctx, "5", pos); err != nil {
				t.Fatal(err)
			}
			last := f.log[len(f.log)-1]
			if got := last.Method + " " + last.Path; got != c.want || !strings.Contains(last.Body, "factory:data") {
				t.Fatalf("write = %s %s, want %s", got, last.Body, c.want)
			}
		})
	}
}
