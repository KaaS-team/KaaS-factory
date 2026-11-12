package pick

import (
	"reflect"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

const wf = ".github/workflows/ci.yml"

func TestRefillRoutedTable(t *testing.T) {
	cases := []struct {
		name     string
		o        Options
		files    []string
		wantPick Route
		wantSkip string
	}{
		{"workflow, cloud only: skipped", Options{Dispatcher: "routines"}, []string{wf}, "", ReasonNeedsLocal},
		{"workflow, local fallback: routed local", Options{Dispatcher: "routines", LocalFallback: true}, []string{wf}, RouteLocal, ""},
		{"workflow, local dispatcher: default is already local", Options{Dispatcher: "local"}, []string{wf}, RouteDefault, ""},
		{"normal file, cloud only: cloud", Options{Dispatcher: "routines"}, []string{"src/a.ts"}, RouteDefault, ""},
		{"normal file, local fallback: cloud", Options{Dispatcher: "routines", LocalFallback: true}, []string{"src/a.ts"}, RouteDefault, ""},
		{"mixed files count as workflow", Options{Dispatcher: "routines"}, []string{"src/a.ts", wf}, "", ReasonNeedsLocal},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := RefillRouted(3, []api.Ticket{tk("a", 1, 1, c.files...)}, nil, Locks{}, 3, c.o)
			if c.wantSkip != "" {
				if len(r.Picks) != 0 || len(r.Skipped) != 1 || r.Skipped[0].Reason != c.wantSkip || r.Skipped[0].Ticket.ID != "a" {
					t.Fatalf("got %+v", r)
				}
				return
			}
			if len(r.Skipped) != 0 || len(r.Picks) != 1 || r.Picks[0].Route != c.wantPick {
				t.Fatalf("got %+v", r)
			}
		})
	}
}

func TestLocalOnlyGlobEdges(t *testing.T) {
	cases := []struct {
		file string
		want bool
	}{
		{".github/workflows", true},
		{".github/workflows/", true},
		{".github/workflows/ci.yml", true},
		{".github/workflows/sub/deep/x.yml", true},
		{"./.github/workflows/ci.yml", true},
		{".github/other", false},
		{".github/other/workflows/ci.yml", false},
		{".github/workflows-old/x.yml", false},
		{".github", false},
		{"src/.github/workflows/x.yml", false},
		{"", false},
	}
	for _, c := range cases {
		if got := LocalOnly([]string{c.file}); got != c.want {
			t.Errorf("%q: got %v want %v", c.file, got, c.want)
		}
	}
	if LocalOnly(nil) {
		t.Error("no files is not local-only")
	}
}

func TestRefillRoutedSkipHoldsNoSlotAndBlocksDependents(t *testing.T) {
	skipped := tk("w", 0, 1, wf)
	dep := tk("d", 1, 2, "x/")
	dep.BlockedBy = []api.TicketID{"w"}
	other := tk("o", 2, 3, "y/")
	r := RefillRouted(1, []api.Ticket{skipped, dep, other}, nil, Locks{}, 5, Options{Dispatcher: "routines"})
	if got := []string{string(r.Picks[0].Ticket.ID)}; len(r.Picks) != 1 || !reflect.DeepEqual(got, []string{"o"}) {
		t.Fatalf("picks %+v", r.Picks)
	}
	if len(r.Skipped) != 1 || r.Skipped[0].Ticket.ID != "w" {
		t.Fatalf("skipped %+v", r.Skipped)
	}
}
