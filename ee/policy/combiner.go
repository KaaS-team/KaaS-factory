//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy

import "context"

// Effect is what a matching combiner rule asks for.
type Effect string

// The two effects a combiner rule can have.
const (
	Permit Effect = "permit"
	Forbid Effect = "forbid"
)

// CombinerRule is one rule: an id, an effect, and a function that says whether it matches.
type CombinerRule struct {
	ID     string
	Effect Effect
	Match  func(context.Context) (bool, error)
}

// RuleError records a rule whose Match returned an error. The rule counted as a non-match.
type RuleError struct {
	RuleID string
	Err    error
}

// Combined is the verdict of Combine: whether to allow, the rule ids that decided it, and the
// rules that errored.
type Combined struct {
	Allow       bool
	Determining []string
	Errors      []RuleError
}

// Combine applies deny-overrides. Any matching forbid denies and Determining lists the matching
// forbids. Otherwise a matching permit allows and Determining lists the matching permits. With no
// match the result is a denial with no determining rules. A rule that errors is a non-match and
// appears in Errors.
func Combine(ctx context.Context, rules []CombinerRule) Combined {
	var out Combined
	var forbids, permits []string
	for _, r := range rules {
		hit, err := r.Match(ctx)
		if err != nil {
			out.Errors = append(out.Errors, RuleError{RuleID: r.ID, Err: err})
			continue
		}
		if !hit {
			continue
		}
		switch r.Effect {
		case Forbid:
			forbids = append(forbids, r.ID)
		case Permit:
			permits = append(permits, r.ID)
		}
	}
	switch {
	case len(forbids) > 0:
		out.Determining = forbids
	case len(permits) > 0:
		out.Allow, out.Determining = true, permits
	}
	return out
}
