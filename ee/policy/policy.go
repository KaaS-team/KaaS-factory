//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

// Package policy decides, before an action runs, whether an actor may do it. Rules are YAML; a
// deny rule beats an allow rule, and anything no rule allows is denied.
package policy

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"path"

	"gopkg.in/yaml.v3"
)

// Action is something the factory does on someone's behalf.
type Action string

// The actions a check runs before.
const (
	ActionDispatch Action = "dispatch"
	ActionMerge    Action = "merge"
	ActionSetPhase Action = "set_phase"
)

// Rule ids the engine reports when no YAML rule decided.
const (
	RuleDefaultDeny   = "default-deny"
	RuleUnknownAction = "unknown-action"
)

// Actor is the identity an action runs as: one per agent or person.
type Actor struct {
	ID   string
	Role string
}

// Resource is what the action touches: a repo and the spend it would add, in USD.
type Resource struct {
	Repo string
	USD  float64
}

// Decision is the verdict of one check and the rule that produced it.
type Decision struct {
	Allow  bool
	RuleID string
	Reason string
}

// Rule is one YAML entry. An empty Roles or Repos matches any; Actions is required.
type Rule struct {
	ID     string   `yaml:"id"`
	Effect string   `yaml:"effect"`
	Roles  []string `yaml:"roles"`
	Repos  []string `yaml:"repos"`
	Action []string `yaml:"actions"`
	MaxUSD *float64 `yaml:"max_usd"`
}

// Engine holds parsed rules and answers Check.
type Engine struct {
	rules []Rule
}

var known = map[Action]bool{ActionDispatch: true, ActionMerge: true, ActionSetPhase: true}

// Parse reads a YAML rule list and rejects unknown fields, effects and actions, bad globs and
// duplicate ids. It reports every bad rule in one error.
func Parse(data []byte) (*Engine, error) {
	var doc struct {
		Rules []Rule `yaml:"rules"`
	}
	dec := yaml.NewDecoder(bytes.NewReader(data))
	dec.KnownFields(true)
	if err := dec.Decode(&doc); err != nil {
		return nil, fmt.Errorf("policy: %w", err)
	}
	seen := map[string]bool{}
	var bad []error
	for _, r := range doc.Rules {
		if r.ID == "" {
			bad = append(bad, fmt.Errorf("a rule has no id"))
			continue
		}
		if seen[r.ID] {
			bad = append(bad, fmt.Errorf("duplicate rule id %q", r.ID))
		}
		seen[r.ID] = true
		bad = append(bad, r.problems()...)
	}
	if len(bad) > 0 {
		return nil, fmt.Errorf("policy: %d bad rules: %w", len(bad), errors.Join(bad...))
	}
	return &Engine{rules: doc.Rules}, nil
}

// Check evaluates the rules for one action. Deny rules are tried first, then allow rules; an
// allow rule whose max_usd the resource exceeds does not allow. No match is a denial.
func (e *Engine) Check(_ context.Context, who Actor, act Action, res Resource) Decision {
	if !known[act] {
		return Decision{RuleID: RuleUnknownAction, Reason: fmt.Sprintf("action %q is not known", act)}
	}
	for _, r := range e.rules {
		if r.Effect == "deny" && r.matches(who, act, res) {
			return Decision{RuleID: r.ID, Reason: fmt.Sprintf("rule %s denies %s for role %s", r.ID, act, who.Role)}
		}
	}
	over := ""
	for _, r := range e.rules {
		if r.Effect != "allow" || !r.matches(who, act, res) {
			continue
		}
		if r.MaxUSD != nil && res.USD > *r.MaxUSD {
			if over == "" {
				over = r.ID
			}
			continue
		}
		return Decision{Allow: true, RuleID: r.ID, Reason: fmt.Sprintf("rule %s allows %s for role %s", r.ID, act, who.Role)}
	}
	if over != "" {
		return Decision{RuleID: over, Reason: fmt.Sprintf("rule %s caps spend and %.2f USD is over it", over, res.USD)}
	}
	return Decision{RuleID: RuleDefaultDeny, Reason: fmt.Sprintf("no rule allows %s for role %s on %s", act, who.Role, res.Repo)}
}

// problems lists everything wrong with one rule.
func (r Rule) problems() []error {
	var bad []error
	add := func(f string, a ...any) { bad = append(bad, fmt.Errorf("rule %q: "+f, append([]any{r.ID}, a...)...)) }
	if r.Effect != "allow" && r.Effect != "deny" {
		add("effect must be allow or deny")
	}
	if len(r.Action) == 0 {
		add("actions is required")
	}
	for _, a := range r.Action {
		if !known[Action(a)] {
			add("unknown action %q", a)
		}
	}
	for _, g := range r.Repos {
		if _, err := path.Match(g, ""); err != nil {
			add("bad repo glob %q", g)
		}
	}
	if r.MaxUSD != nil && *r.MaxUSD < 0 {
		add("max_usd must be 0 or more")
	}
	return bad
}

func (r Rule) matches(who Actor, act Action, res Resource) bool {
	return in(r.Action, string(act)) && (len(r.Roles) == 0 || in(r.Roles, who.Role)) && r.repoMatches(res.Repo)
}

func (r Rule) repoMatches(repo string) bool {
	if len(r.Repos) == 0 {
		return true
	}
	for _, g := range r.Repos {
		if ok, _ := path.Match(g, repo); ok {
			return true
		}
	}
	return false
}

func in(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
