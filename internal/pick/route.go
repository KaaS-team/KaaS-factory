package pick

import (
	"path"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

// Route says which dispatcher a picked ticket goes to.
type Route string

const (
	// RouteDefault is the configured dispatcher, whatever it is.
	RouteDefault Route = "default"
	// RouteLocal is the local dispatcher, used for tickets cloud tokens cannot push.
	RouteLocal Route = "local"
)

// ReasonNeedsLocal is the skip reason for a workflow-file ticket when no local dispatcher is available.
const ReasonNeedsLocal = "needs local dispatcher"

// Options is the dispatcher configuration that routing reads.
type Options struct {
	// Dispatcher is the configured dispatcher name ("local", "routines", ...).
	Dispatcher string
	// LocalFallback says a local dispatcher runs alongside a non-local one.
	LocalFallback bool
}

// Picked is a ticket chosen to start now and where it goes.
type Picked struct {
	Ticket api.Ticket
	Route  Route
}

// Skipped is a ticket refill passed over for a routing reason, for the board.
type Skipped struct {
	Ticket api.Ticket
	Reason string
}

// Result is what RefillRouted decides: picks in rank order and the routing skips.
type Result struct {
	Picks   []Picked
	Skipped []Skipped
}

// LocalOnly reports whether any file is .github/workflows or inside it
// (cloud tokens cannot push there, #635). Paths are cleaned first, so
// "./.github/workflows/ci.yml" matches and ".github/other" does not.
func LocalOnly(files []string) bool {
	for _, f := range files {
		p := path.Clean(strings.TrimSpace(f))
		if p == ".github/workflows" || strings.HasPrefix(p, ".github/workflows/") {
			return true
		}
	}
	return false
}

// RefillRouted is Refill with dispatcher routing. A local-only ticket goes to
// the local dispatcher when it is the configured one or when LocalFallback is
// set; otherwise it is skipped with ReasonNeedsLocal and takes no slot and
// holds no files. Everything else follows Refill's rules.
func RefillRouted(free int, ranked, running []api.Ticket, locks Locks, firesLeft int, o Options) Result {
	localOK := o.Dispatcher == "local" || o.LocalFallback
	res := Result{Picks: []Picked{}, Skipped: []Skipped{}}
	eligible := make([]api.Ticket, 0, len(ranked))
	skip := map[api.TicketID]bool{}
	for _, t := range ranked {
		if LocalOnly(t.Files) && !localOK {
			skip[t.ID] = true
			res.Skipped = append(res.Skipped, Skipped{Ticket: t, Reason: ReasonNeedsLocal})
			continue
		}
		eligible = append(eligible, t)
	}
	// Skipped tickets stay in the open set so tickets they block stay blocked.
	locks2 := Locks{Files: locks.Files, Unmerged: map[api.TicketID]bool{}}
	for id, v := range locks.Unmerged {
		locks2.Unmerged[id] = v
	}
	for id := range skip {
		locks2.Unmerged[id] = true
	}
	for _, t := range Refill(free, eligible, running, locks2, firesLeft) {
		r := RouteDefault
		if LocalOnly(t.Files) && o.Dispatcher != "local" {
			r = RouteLocal
		}
		res.Picks = append(res.Picks, Picked{Ticket: t, Route: r})
	}
	return res
}
