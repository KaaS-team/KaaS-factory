// Package pick ranks ready tickets and fills free slots with work that can
// run side by side. It is pure: no clock, no I/O, no state.
package pick

import (
	"sort"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

// Locks is what is held besides the running tickets themselves.
type Locks struct {
	// Files are paths held by work that is no longer running but not merged.
	Files []string
	// Unmerged are tickets known to be open that no other list shows.
	Unmerged map[api.TicketID]bool
}

// Rank returns a copy of ready ordered by priority (lower first), then oldest
// creation time (zero time last), then id.
func Rank(ready []api.Ticket) []api.Ticket {
	out := append([]api.Ticket(nil), ready...)
	sort.SliceStable(out, func(i, j int) bool {
		a, b := out[i], out[j]
		if a.Priority != b.Priority {
			return a.Priority < b.Priority
		}
		if a.CreatedAt.IsZero() != b.CreatedAt.IsZero() {
			return !a.CreatedAt.IsZero()
		}
		if !a.CreatedAt.Equal(b.CreatedAt) {
			return a.CreatedAt.Before(b.CreatedAt)
		}
		return a.ID < b.ID
	})
	return out
}

func norm(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "./")
	return strings.TrimRight(p, "/")
}

func conflict(a, b string) bool {
	na, nb := norm(a), norm(b)
	if na == "" || nb == "" {
		return false
	}
	return na == nb || strings.HasPrefix(na, nb+"/") || strings.HasPrefix(nb, na+"/")
}

// Overlap reports whether any path in a is the same as, or inside, or a
// directory containing, any path in b. An empty list overlaps nothing.
func Overlap(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if conflict(x, y) {
				return true
			}
		}
	}
	return false
}

// Refill returns the tickets from ranked to start now, in rank order. It
// returns at most min(free, firesLeft) tickets, none whose Files overlap a
// running ticket, a held lock or an earlier pick, and none with an unmerged
// blocker. A skipped ticket is not dropped; the caller offers it next tick.
func Refill(free int, ranked []api.Ticket, running []api.Ticket, locks Locks, firesLeft int) []api.Ticket {
	limit := min(free, firesLeft)
	out := []api.Ticket{}
	if limit <= 0 {
		return out
	}
	held := append([]string(nil), locks.Files...)
	open := map[api.TicketID]bool{}
	for id, v := range locks.Unmerged {
		if v {
			open[id] = true
		}
	}
	for _, r := range running {
		held = append(held, r.Files...)
		open[r.ID] = true
	}
	for _, t := range ranked {
		open[t.ID] = true
	}
	isRunning := map[api.TicketID]bool{}
	for _, r := range running {
		isRunning[r.ID] = true
	}
	for _, t := range ranked {
		if len(out) >= limit {
			break
		}
		if isRunning[t.ID] || blocked(t, open) || Overlap(t.Files, held) {
			continue
		}
		out = append(out, t)
		held = append(held, t.Files...)
	}
	return out
}

func blocked(t api.Ticket, open map[api.TicketID]bool) bool {
	for _, b := range t.BlockedBy {
		if open[b] {
			return true
		}
	}
	return false
}
