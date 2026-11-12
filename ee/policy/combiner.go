//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy

import (
	"context"
	"errors"
	"fmt"
)

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
// match the result is a denial with no determining rules. A permit that errors is a non-match; a forbid that errors, a rule with an
// unknown effect or no matcher is a matching forbid. Every erroring rule appears in Errors.
func Combine(ctx context.Context, rules []CombinerRule) Combined {
	var out Combined
	var forbids, permits []string
	for _, r := range rules {
		hit, err := match(ctx, r)
		if err != nil {
			out.Errors = append(out.Errors, RuleError{RuleID: r.ID, Err: err})
			if r.Effect != Permit { // a forbid that cannot be evaluated must not let a permit through
				forbids = append(forbids, r.ID)
			}
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
		default: // an effect we do not know is a denial, never a permit
			out.Errors = append(out.Errors, RuleError{RuleID: r.ID, Err: fmt.Errorf("unknown effect %q", r.Effect)})
			forbids = append(forbids, r.ID)
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

func match(ctx context.Context, r CombinerRule) (bool, error) {
	if r.Match == nil {
		return false, errors.New("rule has no matcher")
	}
	return r.Match(ctx)
}
