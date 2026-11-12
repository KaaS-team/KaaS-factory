package github_test

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/meter"
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
