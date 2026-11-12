package depup

import (
	"fmt"
	"time"
)

// Route is who handles an update.
type Route string

// The routes an update type can take.
const (
	ToAgent       Route = "agent"
	Deterministic Route = "deterministic"
)

// SkipTooYoung starts the reason recorded on an update held back by the release-age gate.
const SkipTooYoung = "younger than minimum release age"

// Gate holds updates until a release is old enough and routes the rest by update type.
// The zero value passes everything and uses the default routing.
type Gate struct {
	MinAge  time.Duration
	Routing map[Type]Route // overrides per type; unset types use the default
}

// Status is a commit status the caller posts on the PR.
type Status struct{ Context, State, Description string }

// Route returns the configured route for t: major goes to an agent, minor and patch to the
// deterministic path, and an unknown type goes to an agent.
func (g Gate) Route(t Type) Route {
	if r, ok := g.Routing[t]; ok {
		return r
	}
	if t == Minor || t == Patch {
		return Deterministic
	}
	return ToAgent
}

// Ready reports whether u is old enough at now, and the time left when it is not.
// A release with no known date is never ready.
func (g Gate) Ready(u Update, now time.Time) (bool, time.Duration) {
	if g.MinAge <= 0 {
		return true, 0
	}
	if u.ReleasedAt.IsZero() {
		return false, g.MinAge
	}
	if left := g.MinAge - now.Sub(u.ReleasedAt); left > 0 {
		return false, left
	}
	return true, 0
}

// Split sorts ticketable decisions into agent and deterministic work and holds the young ones with a
// recorded reason. Decisions that already carry a skip reason are dropped from all three lists.
func (g Gate) Split(ds []Decision, now time.Time) (agent, det, held []Decision) {
	for _, d := range ds {
		if d.SkipReason != "" {
			continue
		}
		if ok, left := g.Ready(d.Update, now); !ok {
			d.SkipReason = fmt.Sprintf("%s: %s left", SkipTooYoung, left.Round(time.Hour))
			held = append(held, d)
		} else if g.Route(d.Type) == ToAgent {
			agent = append(agent, d)
		} else {
			det = append(det, d)
		}
	}
	return agent, det, held
}

// Status is the release-age check shown on the PR: pending with the time left, or success.
func (g Gate) Status(u Update, now time.Time) Status {
	s := Status{Context: "depup/release-age", State: "success", Description: "release is old enough"}
	if ok, left := g.Ready(u, now); !ok {
		s.State, s.Description = "pending", fmt.Sprintf("%s left of %s", left.Round(time.Hour), g.MinAge)
	}
	return s
}
