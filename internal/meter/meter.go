// Package meter turns the absolute usage totals that sessions report into
// deltas, sums them per node, ticket and team-day, and checks them against
// budgets (Symphony §13.5: absolute totals in, deltas derived, never double
// counted).
package meter

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// ErrTotalDecreased is returned by Record when a reported absolute total is
// lower than the one before it for the same key.
var ErrTotalDecreased = errors.New("meter: usage total went down")

// Verdict is what Check says about a key's tightest budget.
type Verdict string

// The three verdicts: carry on, tell the session to wrap up, stop it.
const (
	OK    Verdict = "ok"
	Steer Verdict = "steer" // at or above 80% of a cap
	Stop  Verdict = "stop"  // at or above 100% of a cap
)

// Key names one stream of absolute totals. Session separates attempts, so a
// new attempt starting from zero is not a decrease. Team and Ticket group
// spend for the ticket and team-day budgets; Node groups it for the node one.
type Key struct {
	Team    string
	Ticket  api.TicketID
	Node    string
	Session string
}

// Budgets holds one cap per level. A zero field means no cap at that level.
type Budgets struct {
	Node    api.Budget
	Ticket  api.Budget
	TeamDay api.Budget
}

// Spent is the usage summed at each level for a key.
type Spent struct {
	Node    api.Usage
	Ticket  api.Usage
	TeamDay api.Usage
}

type nodeKey struct {
	team   string
	ticket api.TicketID
	node   string
}

type ticketKey struct {
	team   string
	ticket api.TicketID
}

type teamDayKey struct {
	team string
	day  string
}

// Meter accumulates usage. It is safe for concurrent use.
type Meter struct {
	budgets Budgets
	now     func() time.Time

	mu      sync.Mutex
	last    map[Key]api.Usage
	nodes   map[nodeKey]api.Usage
	tickets map[ticketKey]api.Usage
	days    map[teamDayKey]api.Usage
}

// New returns a Meter that checks against budgets and reads the day from now.
func New(budgets Budgets, now func() time.Time) *Meter {
	return &Meter{
		budgets: budgets,
		now:     now,
		last:    map[Key]api.Usage{},
		nodes:   map[nodeKey]api.Usage{},
		tickets: map[ticketKey]api.Usage{},
		days:    map[teamDayKey]api.Usage{},
	}
}

func add(a, b api.Usage) api.Usage {
	return api.Usage{
		InputTokens:      a.InputTokens + b.InputTokens,
		OutputTokens:     a.OutputTokens + b.OutputTokens,
		CacheReadTokens:  a.CacheReadTokens + b.CacheReadTokens,
		CacheWriteTokens: a.CacheWriteTokens + b.CacheWriteTokens,
		CostUSD:          a.CostUSD + b.CostUSD,
		WallTime:         a.WallTime + b.WallTime,
	}
}

// Record takes the absolute total a session reports and adds the difference
// from its previous total to every level. It returns that difference. A cost
// of zero means unknown, so it adds nothing and keeps the last known cost.
// A total lower than the previous one returns ErrTotalDecreased and changes
// nothing.
func (m *Meter) Record(k Key, total api.Usage) (api.Usage, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	prev := m.last[k]
	if total.CostUSD == 0 {
		total.CostUSD = prev.CostUSD
	}
	var field string
	switch {
	case total.InputTokens < prev.InputTokens:
		field = "input tokens"
	case total.OutputTokens < prev.OutputTokens:
		field = "output tokens"
	case total.CacheReadTokens < prev.CacheReadTokens:
		field = "cache read tokens"
	case total.CacheWriteTokens < prev.CacheWriteTokens:
		field = "cache write tokens"
	case total.CostUSD < prev.CostUSD:
		field = "cost"
	case total.WallTime < prev.WallTime:
		field = "wall time"
	}
	if field != "" {
		return api.Usage{}, fmt.Errorf("%w: %s for session %q", ErrTotalDecreased, field, k.Session)
	}
	delta := api.Usage{
		InputTokens:      total.InputTokens - prev.InputTokens,
		OutputTokens:     total.OutputTokens - prev.OutputTokens,
		CacheReadTokens:  total.CacheReadTokens - prev.CacheReadTokens,
		CacheWriteTokens: total.CacheWriteTokens - prev.CacheWriteTokens,
		CostUSD:          total.CostUSD - prev.CostUSD,
		WallTime:         total.WallTime - prev.WallTime,
	}
	m.last[k] = total
	nk, tk, dk := m.keys(k)
	m.nodes[nk] = add(m.nodes[nk], delta)
	m.tickets[tk] = add(m.tickets[tk], delta)
	m.days[dk] = add(m.days[dk], delta)
	return delta, nil
}

func (m *Meter) keys(k Key) (nodeKey, ticketKey, teamDayKey) {
	return nodeKey{k.Team, k.Ticket, k.Node}, ticketKey{k.Team, k.Ticket}, teamDayKey{k.Team, m.now().UTC().Format("2006-01-02")}
}

// Used returns what has been recorded at each level for k. The team-day level
// is today's (UTC).
func (m *Meter) Used(k Key) Spent {
	m.mu.Lock()
	defer m.mu.Unlock()
	nk, tk, dk := m.keys(k)
	return Spent{Node: m.nodes[nk], Ticket: m.tickets[tk], TeamDay: m.days[dk]}
}

// Check compares usage with the budgets at all three levels and returns the
// verdict of the tightest one: Steer at 80% of any cap, Stop at 100%. Tokens
// are input plus output; cache tokens are priced into the cost cap instead.
func (m *Meter) Check(k Key) Verdict {
	used := m.Used(k)
	v := OK
	for _, l := range []struct {
		b api.Budget
		u api.Usage
	}{{m.budgets.Node, used.Node}, {m.budgets.Ticket, used.Ticket}, {m.budgets.TeamDay, used.TeamDay}} {
		if w := verdict(l.b, l.u); w == Stop {
			return Stop
		} else if w == Steer {
			v = Steer
		}
	}
	return v
}

func verdict(b api.Budget, u api.Usage) Verdict {
	v := OK
	for _, d := range []struct{ used, cap float64 }{
		{float64(u.InputTokens + u.OutputTokens), float64(b.Tokens)},
		{u.CostUSD, b.USD},
		{float64(u.WallTime), float64(b.WallClock)},
	} {
		switch {
		case d.cap <= 0:
		case d.used >= d.cap:
			return Stop
		// used >= 0.8*cap, written with integers so that exactly 80% is steer.
		case d.used*5 >= d.cap*4:
			v = Steer
		}
	}
	return v
}
