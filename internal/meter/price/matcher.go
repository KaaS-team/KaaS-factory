// Ported from langfuse/langfuse@2e6d034 packages/shared/src/server/pricing-tiers/matcher.ts

// Package price holds the embedded model price catalog and prices usage from it. A model the
// catalog does not know is flagged unpriced, never zero. Prices are operator-only data.
package price

import (
	"math/big"
	"regexp"
	"slices"
	"sort"
)

// Usage maps a usage type such as "input" or "cache_read_input_tokens" to a unit count.
type Usage map[string]float64

// Price is a per-unit price in dollars, held exactly.
type Price struct{ r *big.Rat }

// Condition is one test on a tier. With Source set it checks an attribute; otherwise it sums the
// usage types matching Pattern and compares the sum to Value.
type Condition struct {
	Source        string   `json:"source"`
	Key           string   `json:"key"`
	Values        []string `json:"values"`
	Pattern       string   `json:"usageDetailPattern"`
	Operator      string   `json:"operator"`
	Value         float64  `json:"value"`
	CaseSensitive bool     `json:"caseSensitive"`
}

// Tier is one price list and the conditions under which it applies.
type Tier struct {
	ID         string           `json:"id"`
	Name       string           `json:"name"`
	IsDefault  bool             `json:"isDefault"`
	Priority   int              `json:"priority"`
	Conditions []Condition      `json:"conditions"`
	Prices     map[string]Price `json:"prices"`
}

type matchAttrs struct{ params, meta map[string]string }

func (c Condition) holds(u Usage, a matchAttrs) bool {
	if c.Source != "" {
		vals := a.meta
		if c.Source == "model_parameters" {
			vals = a.params
		}
		v, ok := vals[c.Key]
		return ok && slices.Contains(c.Values, v)
	}
	pat := c.Pattern
	if !c.CaseSensitive {
		pat = "(?i)" + pat
	}
	re, err := regexp.Compile(pat)
	if err != nil {
		return false // fail-safe: a bad condition never matches
	}
	keys := make([]string, 0, len(u))
	for k := range u {
		if re.MatchString(k) {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys) // fixed order keeps the float sum repeatable
	var sum float64
	for _, k := range keys {
		sum += u[k]
	}
	switch c.Operator {
	case "gt":
		return sum > c.Value
	case "gte":
		return sum >= c.Value
	case "lt":
		return sum < c.Value
	case "lte":
		return sum <= c.Value
	case "eq":
		return sum == c.Value
	case "neq":
		return sum != c.Value
	}
	return false
}

// matchTier returns the first non-default tier, by priority, whose conditions all hold, else the
// default tier, else nil. A tier with no conditions never matches except as the default.
func matchTier(tiers []Tier, u Usage, a matchAttrs) *Tier {
	var sorted []*Tier
	var def *Tier
	for i := range tiers {
		if tiers[i].IsDefault {
			def = &tiers[i]
		} else {
			sorted = append(sorted, &tiers[i])
		}
	}
	sort.SliceStable(sorted, func(i, j int) bool { return sorted[i].Priority < sorted[j].Priority })
	for _, t := range sorted {
		if len(t.Conditions) == 0 {
			continue
		}
		ok := true
		for _, c := range t.Conditions {
			ok = ok && c.holds(u, a)
		}
		if ok {
			return t
		}
	}
	return def
}
