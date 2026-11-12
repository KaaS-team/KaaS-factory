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
	// Branches names the branch of each ticket that has one, running or ready.
	Branches map[api.TicketID]string
	// Merge returns the paths that conflict when two branches merge, nil when clean.
	// With Merge nil, an overlap always blocks.
	Merge func(a, b string) ([]string, error)
	// Parked are tickets in the dead-letter park; Refill never picks them.
	Parked map[api.TicketID]bool
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

// Skip says why Refill passed over a ticket this tick.
type Skip struct {
	ID     api.TicketID
	Reason string // one line, e.g. "blocked by dep" or "files overlap T1; merge-tree conflicts: a.go"
}

// holder is one held write set: a running ticket, an earlier pick or a bare lock.
type holder struct {
	id    api.TicketID
	files []string
	// branch is empty when the holder has none, which is always so for a bare lock.
	branch string
}

// Refill returns the tickets from ranked to start now, in rank order, and one
// Skip per ticket it passed over. It returns at most min(free, firesLeft)
// tickets, none with an unmerged blocker, none already running, and none whose
// Files overlap a running ticket, a held lock or an earlier pick, unless both
// tickets have a branch in locks.Branches and locks.Merge reports no conflict
// between them (a Merge error counts as a conflict). A skipped ticket is not
// dropped; the caller offers it next tick.
func Refill(free int, ranked []api.Ticket, running []api.Ticket, locks Locks, firesLeft int) ([]api.Ticket, []Skip) {
	limit := min(free, firesLeft)
	out := []api.Ticket{}
	if limit <= 0 {
		return out, nil
	}
	held := []holder{{files: locks.Files}}
	open := map[api.TicketID]bool{}
	for id, v := range locks.Unmerged {
		if v {
			open[id] = true
		}
	}
	isRunning := map[api.TicketID]bool{}
	for _, r := range running {
		held = append(held, holder{r.ID, r.Files, locks.Branches[r.ID]})
		open[r.ID] = true
		isRunning[r.ID] = true
	}
	for _, t := range ranked {
		open[t.ID] = true
	}
	var skips []Skip
	for _, t := range ranked {
		if len(out) >= limit {
			break
		}
		if isRunning[t.ID] {
			continue
		}
		if locks.Parked[t.ID] {
			skips = append(skips, Skip{t.ID, "parked in DLQ"})
			continue
		}
		if b := blocker(t, open); b != "" {
			skips = append(skips, Skip{t.ID, "blocked by " + string(b)})
			continue
		}
		if why := overlap(t, locks, held); why != "" {
			skips = append(skips, Skip{t.ID, why})
			continue
		}
		out = append(out, t)
		held = append(held, holder{t.ID, t.Files, locks.Branches[t.ID]})
	}
	return out, skips
}

// overlap returns why t must wait for a holder, or "" when it may start.
func overlap(t api.Ticket, locks Locks, held []holder) string {
	for _, h := range held {
		if !Overlap(t.Files, h.files) {
			continue
		}
		who := "a held lock"
		if h.id != "" {
			who = string(h.id)
		}
		tb := locks.Branches[t.ID]
		if tb == "" || h.branch == "" || locks.Merge == nil {
			return "files overlap " + who
		}
		paths, err := locks.Merge(tb, h.branch)
		switch {
		case err != nil:
			return "files overlap " + who + "; merge-tree failed: " + err.Error()
		case len(paths) > 0:
			return "files overlap " + who + "; merge-tree conflicts: " + strings.Join(paths, ", ")
		}
	}
	return ""
}

func blocker(t api.Ticket, open map[api.TicketID]bool) api.TicketID {
	for _, b := range t.BlockedBy {
		if open[b] {
			return b
		}
	}
	return ""
}
