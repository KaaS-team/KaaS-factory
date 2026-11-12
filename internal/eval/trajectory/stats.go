package trajectory

import (
	"fmt"
	"sort"
	"strings"
)

// Stats summarises a set of trajectories.
type Stats struct {
	Tasks        int            `json:"tasks"`
	ByState      map[string]int `json:"by_state"`
	PassRate     float64        `json:"pass_rate"`
	MeanSteps    float64        `json:"mean_steps"`
	MedianSteps  float64        `json:"median_steps"`
	InputTokens  int64          `json:"input_tokens"`
	OutputTokens int64          `json:"output_tokens"`
	CostUSD      float64        `json:"cost_usd"`
}

// Summarize computes Stats. An empty set gives the zero Stats.
func Summarize(ts []Trajectory) Stats {
	s := Stats{Tasks: len(ts), ByState: map[string]int{}}
	var steps []int
	total := 0
	for _, t := range ts {
		s.ByState[t.State]++
		steps = append(steps, len(t.Steps))
		total += len(t.Steps)
		s.InputTokens += t.Cost.InputTokens
		s.OutputTokens += t.Cost.OutputTokens
		s.CostUSD += t.Cost.CostUSD
	}
	if s.Tasks == 0 {
		return s
	}
	s.PassRate = float64(s.ByState[StatePass]) / float64(s.Tasks)
	s.MeanSteps = float64(total) / float64(s.Tasks)
	sort.Ints(steps)
	n := len(steps)
	if n%2 == 1 {
		s.MedianSteps = float64(steps[n/2])
	} else {
		s.MedianSteps = float64(steps[n/2-1]+steps[n/2]) / 2
	}
	return s
}

// Markdown renders the statistics. The state rows are sorted by name.
func (s Stats) Markdown() string {
	var b strings.Builder
	fmt.Fprintf(&b, "- Tasks: %d\n- Pass rate: %.2f\n- Steps per task: mean %.1f, median %.1f\n", s.Tasks, s.PassRate, s.MeanSteps, s.MedianSteps)
	fmt.Fprintf(&b, "- Tokens: %d in, %d out\n- Cost: $%.4f\n", s.InputTokens, s.OutputTokens, s.CostUSD)
	states := make([]string, 0, len(s.ByState))
	for k := range s.ByState {
		states = append(states, k)
	}
	sort.Strings(states)
	for _, k := range states {
		fmt.Fprintf(&b, "- State %s: %d\n", k, s.ByState[k])
	}
	return b.String()
}

// Change is a task whose final state differs between two runs.
type Change struct {
	Task string `json:"task"`
	From string `json:"from"`
	To   string `json:"to"`
}

// Comparison is the result of Compare. Fixed and Regressed count tasks that went to or from pass.
type Comparison struct {
	Old, New Stats
	OnlyOld  []string
	OnlyNew  []string
	Changes  []Change
	Fixed    int
	Regress  int
}

// Compare pairs two runs by task name. Tasks in one run only are listed, not scored.
func Compare(old, next []Trajectory) Comparison {
	c := Comparison{Old: Summarize(old), New: Summarize(next)}
	om := map[string]Trajectory{}
	for _, t := range old {
		om[t.Task] = t
	}
	nm := map[string]bool{}
	for _, t := range next { // next is sorted by Load, so the lists come out sorted
		nm[t.Task] = true
		o, ok := om[t.Task]
		switch {
		case !ok:
			c.OnlyNew = append(c.OnlyNew, t.Task)
		case o.State != t.State:
			c.Changes = append(c.Changes, Change{t.Task, o.State, t.State})
			if t.State == StatePass {
				c.Fixed++
			} else if o.State == StatePass {
				c.Regress++
			}
		}
	}
	for _, t := range old {
		if !nm[t.Task] {
			c.OnlyOld = append(c.OnlyOld, t.Task)
		}
	}
	return c
}

// Markdown renders the comparison as a table of aggregate deltas followed by the per-task changes.
func (c Comparison) Markdown() string {
	var b strings.Builder
	o, n := c.Old, c.New
	b.WriteString("| metric | old | new | delta |\n|---|---|---|---|\n")
	fmt.Fprintf(&b, "| tasks | %d | %d | %+d |\n", o.Tasks, n.Tasks, n.Tasks-o.Tasks)
	fmt.Fprintf(&b, "| pass rate | %.2f | %.2f | %+.2f |\n", o.PassRate, n.PassRate, n.PassRate-o.PassRate)
	fmt.Fprintf(&b, "| mean steps | %.1f | %.1f | %+.1f |\n", o.MeanSteps, n.MeanSteps, n.MeanSteps-o.MeanSteps)
	fmt.Fprintf(&b, "| tokens | %d | %d | %+d |\n", o.InputTokens+o.OutputTokens, n.InputTokens+n.OutputTokens, n.InputTokens+n.OutputTokens-o.InputTokens-o.OutputTokens)
	fmt.Fprintf(&b, "| cost USD | %.4f | %.4f | %+.4f |\n", o.CostUSD, n.CostUSD, n.CostUSD-o.CostUSD)
	fmt.Fprintf(&b, "\nFixed: %d. Regressed: %d.\n", c.Fixed, c.Regress)
	for _, ch := range c.Changes {
		fmt.Fprintf(&b, "- %s: %s -> %s\n", ch.Task, ch.From, ch.To)
	}
	for _, t := range c.OnlyOld {
		fmt.Fprintf(&b, "- %s: only in old\n", t)
	}
	for _, t := range c.OnlyNew {
		fmt.Fprintf(&b, "- %s: only in new\n", t)
	}
	return b.String()
}
