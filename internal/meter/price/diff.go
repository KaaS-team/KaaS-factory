package price

import (
	"encoding/json"
	"fmt"
	"regexp"
	"sort"
	"strings"
)

var (
	ours    = regexp.MustCompile(`^(claude|gpt|o[0-9]|chatgpt)`)
	variant = regexp.MustCompile(`audio|realtime|search`)
)

// Keep reports whether a model name is one the factory runs: Anthropic or OpenAI, no audio,
// realtime or search variants.
func Keep(name string) bool {
	return ours.MatchString(name) && !variant.MatchString(name)
}

// ParseUpstream reads langfuse's default-model-prices.json and keeps only the models we run.
func ParseUpstream(raw []byte) ([]Model, error) {
	var all []Model
	if err := json.Unmarshal(raw, &all); err != nil {
		return nil, fmt.Errorf("price: upstream: %w", err)
	}
	var kept []Model
	for _, m := range all {
		if Keep(m.Name) {
			kept = append(kept, m)
		}
	}
	return kept, nil
}

// Delta lists how the catalog differs from upstream, by model name.
type Delta struct {
	Changed []string // in both, pattern or prices differ
	Missing []string // upstream only
	Removed []string // ours only
}

// Diff compares our models to upstream. A name in overrides is left out of all three lists,
// because the override wins.
func Diff(mine0, upstream, overrides []Model) Delta {
	skip := map[string]bool{}
	for _, m := range overrides {
		skip[m.Name] = true
	}
	mine, theirs := index(mine0), index(upstream)
	var d Delta
	for n, m := range mine {
		switch u, ok := theirs[n]; {
		case skip[n]:
		case !ok:
			d.Removed = append(d.Removed, n)
		case canon(m) != canon(u):
			d.Changed = append(d.Changed, n)
		}
	}
	for n := range theirs {
		if _, ok := mine[n]; !ok && !skip[n] {
			d.Missing = append(d.Missing, n)
		}
	}
	sort.Strings(d.Changed)
	sort.Strings(d.Missing)
	sort.Strings(d.Removed)
	return d
}

// Empty reports whether nothing differs.
func (d Delta) Empty() bool { return len(d.Changed)+len(d.Missing)+len(d.Removed) == 0 }

// Report renders the delta as a Markdown report for the operator.
func (d Delta) Report(sha string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# Price catalog refresh against %s\n\n", sha)
	for _, s := range []struct {
		title string
		names []string
	}{{"Changed upstream", d.Changed}, {"Missing from our catalog", d.Missing}, {"Not in upstream", d.Removed}} {
		fmt.Fprintf(&b, "## %s (%d)\n\n", s.title, len(s.names))
		for _, n := range s.names {
			fmt.Fprintf(&b, "- %s\n", n)
		}
		b.WriteString("\n")
	}
	return b.String()
}

func index(ms []Model) map[string]Model {
	out := map[string]Model{}
	for _, m := range ms {
		if Keep(m.Name) {
			out[m.Name] = m
		}
	}
	return out
}

// canon renders a model's pattern, tiers, conditions and exact prices in a fixed order.
func canon(m Model) string {
	var b strings.Builder
	b.WriteString(m.MatchPattern)
	for _, t := range m.Tiers {
		c, _ := json.Marshal(t.Conditions)
		fmt.Fprintf(&b, "|%s,%v,%d,%s", t.Name, t.IsDefault, t.Priority, c)
		keys := make([]string, 0, len(t.Prices))
		for k := range t.Prices {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			fmt.Fprintf(&b, ",%s=%s", k, t.Prices[k].r.RatString())
		}
	}
	return b.String()
}
