//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/KaaS-team/factory/ee/policy"
)

func fixed(id string, e policy.Effect, hit bool) policy.CombinerRule {
	return policy.CombinerRule{ID: id, Effect: e, Match: func(context.Context) (bool, error) { return hit, nil }}
}

func broken(id string, e policy.Effect) policy.CombinerRule {
	return policy.CombinerRule{ID: id, Effect: e, Match: func(context.Context) (bool, error) { return false, errors.New("boom") }}
}

func TestCombine(t *testing.T) {
	P, F := policy.Permit, policy.Forbid
	tests := []struct {
		name    string
		rules   []policy.CombinerRule
		allow   bool
		decided []string
		errs    []string
	}{
		{"empty set denies", nil, false, nil, nil},
		{"no match denies", []policy.CombinerRule{fixed("p1", P, false), fixed("f1", F, false)}, false, nil, nil},
		{"permit allows", []policy.CombinerRule{fixed("p1", P, true), fixed("p2", P, false), fixed("p3", P, true)}, true, []string{"p1", "p3"}, nil},
		{"forbid beats permit", []policy.CombinerRule{fixed("p1", P, true), fixed("f1", F, true), fixed("f2", F, true)}, false, []string{"f1", "f2"}, nil},
		{"erroring forbid is a non-match and reported", []policy.CombinerRule{fixed("p1", P, true), broken("f1", F)}, true, []string{"p1"}, []string{"f1"}},
		{"erroring permit is a non-match and reported", []policy.CombinerRule{broken("p1", P)}, false, nil, []string{"p1"}},
		{"error beside matching forbid still denies", []policy.CombinerRule{broken("p1", P), fixed("f1", F, true)}, false, []string{"f1"}, []string{"p1"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := policy.Combine(context.Background(), tc.rules)
			if got.Allow != tc.allow {
				t.Errorf("Allow = %v, want %v", got.Allow, tc.allow)
			}
			if !reflect.DeepEqual(got.Determining, tc.decided) {
				t.Errorf("Determining = %v, want %v", got.Determining, tc.decided)
			}
			var errs []string
			for _, e := range got.Errors {
				errs = append(errs, e.RuleID)
				if e.Err == nil {
					t.Errorf("rule %s error is nil", e.RuleID)
				}
			}
			if !reflect.DeepEqual(errs, tc.errs) {
				t.Errorf("Errors = %v, want %v", errs, tc.errs)
			}
		})
	}
}
