// Ported from triggerdotdev/trigger.dev@2fbd5c7 packages/redis-worker/src/fair-queue/schedulers/drr.ts
package pick

import (
	"sort"

	"github.com/KaaS-team/factory/internal/api"
)

// Fair orders tickets across repos by deficit round robin and caps how many
// tickets one repo may run at once. The caller keeps one Fair between ticks;
// it is not safe for concurrent use.
type Fair struct {
	quantum, maxDeficit float64
	cap                 int
	deficit             map[string]float64
}

// NewFair returns a Fair that adds quantum credits per repo per round, keeps at
// most maxDeficit, and lets a repo run at most cap tickets (0 means no cap).
func NewFair(quantum, maxDeficit float64, cap int) *Fair {
	return &Fair{quantum: quantum, maxDeficit: maxDeficit, cap: cap, deficit: map[string]float64{}}
}

// Round adds one quantum to each active repo (capped at maxDeficit) and drops
// the deficit of every repo not in active.
func (f *Fair) Round(active []string) {
	keep := make(map[string]float64, len(active))
	for _, r := range active {
		keep[r] = min(f.deficit[r]+f.quantum, f.maxDeficit)
	}
	f.deficit = keep
}

// order interleaves ranked by repo, one ticket per repo per pass, repos with
// the highest deficit first (name breaks ties), each repo keeping its own rank order.
func (f *Fair) order(ranked []api.Ticket) []api.Ticket {
	by := map[string][]api.Ticket{}
	var repos []string
	for _, t := range ranked {
		if _, ok := by[t.Repo]; !ok {
			repos = append(repos, t.Repo)
		}
		by[t.Repo] = append(by[t.Repo], t)
	}
	f.Round(repos)
	sort.SliceStable(repos, func(i, j int) bool {
		a, b := f.deficit[repos[i]], f.deficit[repos[j]]
		if a != b {
			return a > b
		}
		return repos[i] < repos[j]
	})
	out := make([]api.Ticket, 0, len(ranked))
	for len(out) < len(ranked) {
		for _, r := range repos {
			if len(by[r]) > 0 {
				out = append(out, by[r][0])
				by[r] = by[r][1:]
			}
		}
	}
	return out
}

// charge spends one credit of repo for a ticket that started.
func (f *Fair) charge(repo string) { f.deficit[repo]-- }
