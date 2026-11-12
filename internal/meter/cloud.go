package meter

import (
	"fmt"
	"sync"

	"github.com/KaaS-team/factory/internal/api"
)

// CloudUsage feeds repeated reads of a cloud run's absolute totals into a
// Meter, so polling twice never counts twice (Symphony §13.5). A run that has
// never reported usage is recorded as unknown, not zero. It is safe for
// concurrent use.
type CloudUsage struct {
	m *Meter

	mu    sync.Mutex
	known map[Key]bool
	seen  map[Key]bool
	cost  map[Key]float64
}

// NewCloudUsage returns a CloudUsage that records into m.
func NewCloudUsage(m *Meter) *CloudUsage {
	return &CloudUsage{m: m, known: map[Key]bool{}, seen: map[Key]bool{}, cost: map[Key]float64{}}
}

// Meter returns the Meter the deltas go into.
func (c *CloudUsage) Meter() *Meter { return c.m }

// Poll takes one read of the run's absolute total and returns the delta it
// added. A nil total means the read found no usage: the run is marked
// unknown unless it has reported before, and nothing is added.
func (c *CloudUsage) Poll(k Key, total *api.Usage) (api.Usage, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.seen[k] = true
	if total == nil {
		return api.Usage{}, nil
	}
	d, err := c.m.Record(k, *total)
	if err != nil {
		return api.Usage{}, err
	}
	c.known[k] = true
	if total.CostUSD > 0 {
		c.cost[k] = total.CostUSD
	}
	return d, nil
}

// Unknown reports whether k has been polled and never reported usage.
func (c *CloudUsage) Unknown(k Key) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.seen[k] && !c.known[k]
}

// Describe returns the report line for k: "unknown" when the run never
// reported usage, else its token totals.
func (c *CloudUsage) Describe(k Key) string {
	if c.Unknown(k) {
		return "unknown"
	}
	u := c.m.Used(k).Node
	return fmt.Sprintf("%d in, %d out tokens", u.InputTokens, u.OutputTokens)
}

// Spend returns the ledger record for holder: runs polled, the runs that
// never reported usage, and the summed last known cost of the others.
func (c *CloudUsage) Spend(holder string) Spend {
	c.mu.Lock()
	defer c.mu.Unlock()
	s := Spend{Holder: holder, Runs: len(c.seen)}
	for k := range c.seen {
		if !c.known[k] {
			s.UnreportedRuns++
		}
		s.CostUSD += c.cost[k]
	}
	return s
}
