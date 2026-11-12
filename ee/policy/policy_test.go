//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy_test

import (
	"context"
	"testing"

	"github.com/KaaS-team/factory/ee/policy"
)

const rules = `
rules:
  - id: deny-merge-viewer
    effect: deny
    roles: [viewer]
    actions: [merge]
  - id: allow-operator-dispatch
    effect: allow
    roles: [operator, owner]
    actions: [dispatch, set_phase]
    repos: ["acme/*"]
    max_usd: 5
  - id: allow-owner-merge
    effect: allow
    roles: [owner]
    actions: [merge]
    repos: ["acme/*"]
`

func TestCheckTable(t *testing.T) {
	e, err := policy.Parse([]byte(rules))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name   string
		actor  policy.Actor
		action policy.Action
		res    policy.Resource
		allow  bool
		rule   string
	}{
		{"role allowed", policy.Actor{ID: "a", Role: "operator"}, policy.ActionDispatch, policy.Resource{Repo: "acme/api", USD: 1}, true, "allow-operator-dispatch"},
		{"role denied", policy.Actor{ID: "a", Role: "viewer"}, policy.ActionMerge, policy.Resource{Repo: "acme/api"}, false, "deny-merge-viewer"},
		{"repo glob miss", policy.Actor{ID: "a", Role: "operator"}, policy.ActionDispatch, policy.Resource{Repo: "other/api"}, false, policy.RuleDefaultDeny},
		{"spend ceiling hit", policy.Actor{ID: "a", Role: "operator"}, policy.ActionDispatch, policy.Resource{Repo: "acme/api", USD: 5.01}, false, "allow-operator-dispatch"},
		{"spend at ceiling", policy.Actor{ID: "a", Role: "operator"}, policy.ActionDispatch, policy.Resource{Repo: "acme/api", USD: 5}, true, "allow-operator-dispatch"},
		{"unknown action", policy.Actor{ID: "a", Role: "owner"}, policy.Action("format_disk"), policy.Resource{Repo: "acme/api"}, false, policy.RuleUnknownAction},
		{"no matching role", policy.Actor{ID: "a", Role: "stranger"}, policy.ActionSetPhase, policy.Resource{Repo: "acme/api"}, false, policy.RuleDefaultDeny},
		{"owner merge", policy.Actor{ID: "a", Role: "owner"}, policy.ActionMerge, policy.Resource{Repo: "acme/api"}, true, "allow-owner-merge"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := e.Check(context.Background(), c.actor, c.action, c.res)
			if d.Allow != c.allow || d.RuleID != c.rule {
				t.Fatalf("got allow=%v rule=%q reason=%q, want allow=%v rule=%q", d.Allow, d.RuleID, d.Reason, c.allow, c.rule)
			}
			if d.Reason == "" {
				t.Fatal("decision has no reason")
			}
		})
	}
}

func TestParseRejects(t *testing.T) {
	for name, y := range map[string]string{
		"bad effect":     "rules:\n  - id: x\n    effect: maybe\n    actions: [merge]\n",
		"no id":          "rules:\n  - effect: allow\n    actions: [merge]\n",
		"dup id":         "rules:\n  - id: x\n    effect: allow\n    actions: [merge]\n  - id: x\n    effect: deny\n    actions: [merge]\n",
		"unknown action": "rules:\n  - id: x\n    effect: allow\n    actions: [explode]\n",
		"bad glob":       "rules:\n  - id: x\n    effect: allow\n    actions: [merge]\n    repos: [\"[\"]\n",
		"negative usd":   "rules:\n  - id: x\n    effect: allow\n    actions: [merge]\n    max_usd: -1\n",
		"unknown field":  "rules:\n  - id: x\n    effect: allow\n    actions: [merge]\n    bogus: 1\n",
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := policy.Parse([]byte(y)); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
}

func TestDenyBeatsAllowRegardlessOfOrder(t *testing.T) {
	e, err := policy.Parse([]byte("rules:\n  - id: a\n    effect: allow\n    actions: [merge]\n  - id: d\n    effect: deny\n    actions: [merge]\n"))
	if err != nil {
		t.Fatal(err)
	}
	if d := e.Check(context.Background(), policy.Actor{Role: "x"}, policy.ActionMerge, policy.Resource{}); d.Allow || d.RuleID != "d" {
		t.Fatalf("got %+v", d)
	}
}
