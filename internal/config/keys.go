package config

import (
	"strings"
	"time"
)

// Layer names one source of configuration, from lowest precedence to highest.
type Layer string

// The layers, in precedence order. A later layer wins over an earlier one.
const (
	LayerBuiltin Layer = "builtin"
	LayerOrg     Layer = "org"
	LayerTeam    Layer = "team"
	LayerRepo    Layer = "repo"
	LayerEnv     Layer = "env"
	LayerFlags   Layer = "flags"
)

// Layers lists every layer from lowest to highest precedence.
func Layers() []Layer {
	return []Layer{LayerBuiltin, LayerOrg, LayerTeam, LayerRepo, LayerEnv, LayerFlags}
}

type kind int

const (
	kString kind = iota
	kInt
	kFloat
	kDuration
	kList
	kBool
	kRisk
	kRole
)

// ceiling is how an org value bounds the layers below it.
type ceiling int

const (
	ceilNone      ceiling = iota
	ceilMax               // a lower layer may lower the number, never raise it
	ceilSubset            // a lower layer may only remove entries from the list
	ceilRisk              // a lower layer may only pick a risk at or below the org's
	ceilFalse             // when the org sets false, a lower layer cannot set true
	ceilTrue              // when the org sets true, a lower layer cannot set false
	ceilForceTrue         // when the org sets true the value is true, whatever a lower layer sets
	ceilFloor             // the value is never below the org's role; a lower layer may only raise it
)

// spec describes one config key: its type, its bound, its minimum and its builtin value.
type spec struct {
	key  string
	kind kind
	ceil ceiling
	min  float64
	def  any
}

var risks = []string{"low", "medium", "high"}

// roles lists the repository roles from least to most access.
var roles = []string{"read", "triage", "write", "maintain", "admin"}

// specs is the one table of keys. Keys under "models." are open: any tier name is a string.
var specs = []spec{
	{key: "repo", kind: kString, def: ""},
	{key: "tracker", kind: kString, def: "github"},
	{key: "approval", kind: kString, def: "risk"},
	{key: "dispatcher", kind: kString, def: "claude-cloud"},
	{key: "slots", kind: kInt, ceil: ceilMax, min: 1, def: 6},
	{key: "workflow", kind: kString, def: "feature-to-pr"},
	{key: "agents", kind: kList, ceil: ceilSubset, def: []string{"claude"}},
	{key: "packs", kind: kList, ceil: ceilSubset, def: []string{}},
	{key: "budgets.node", kind: kFloat, ceil: ceilMax, def: 5.0},
	{key: "budgets.ticket", kind: kFloat, ceil: ceilMax, def: 12.0},
	{key: "budgets.team_day", kind: kFloat, ceil: ceilMax, def: 100.0},
	{key: "budgets.month", kind: kFloat, ceil: ceilMax, def: 0.0},
	{key: "merge_mode", kind: kString, def: "queue"},
	{key: "batch_size", kind: kInt, ceil: ceilMax, min: 1, def: 1},
	{key: "stall_after", kind: kDuration, def: 20 * time.Minute},
	{key: "models_allowed", kind: kList, ceil: ceilSubset, def: []string{}},
	{key: "base", kind: kString, def: "main"},
	{key: "poll_interval", kind: kDuration, def: 15 * time.Second},
	{key: "stage_timeout", kind: kDuration, def: 15 * time.Minute},
	{key: "max_retries", kind: kInt, ceil: ceilMax, min: 0, def: 3},
	{key: "max_open_prs", kind: kInt, ceil: ceilMax, min: 1, def: 3},
	{key: "gates", kind: kList, def: []string{}},
	{key: "protected_paths", kind: kList, def: []string{}},
	{key: "risk_max", kind: kRisk, ceil: ceilRisk, def: "high"},
	{key: "auto_merge", kind: kBool, ceil: ceilFalse, def: false},
	{key: "auto_merge_max_risk", kind: kRisk, ceil: ceilRisk, def: "low"},
	{key: "requester_cannot_approve", kind: kBool, ceil: ceilTrue, def: true},
	{key: "shadow", kind: kBool, ceil: ceilForceTrue, def: false},
	{key: "sandbox", kind: kBool, def: true},
	{key: "trust.min_role", kind: kRole, ceil: ceilFloor, def: "write"},
	{key: "trust.allow", kind: kList, def: []string{}},
}

// foreign lists the top-level keys of the factory-config org and team files that this package
// accepts and ignores, because they describe the org rather than set a runner value.
var foreign = map[string]bool{
	"name": true, "mission": true, "repos": true, "locked": true, "teams": true,
	"source": true, "roles": true, "approvers": true,
}

// foreignPolicy lists the factory-config "policy" keys with no runner meaning here.
var foreignPolicy = map[string]bool{"deny": true, "preapprove": true, "extend": true}

// policyAlias maps a factory-config "policy" key path to the key it sets here.
var policyAlias = map[string]string{
	"policy.risk_max":                           "risk_max",
	"policy.auto_merge.allowed":                 "auto_merge",
	"policy.auto_merge.max_risk":                "auto_merge_max_risk",
	"policy.models":                             "models_allowed",
	"policy.approvals.requester_cannot_approve": "requester_cannot_approve",
	"policy.budget_usd_month":                   "budgets.month",
	"policy.protected_paths":                    "protected_paths",
}

// Keys lists every fixed key path, in table order. Keys under "models." are open and not listed.
func Keys() []string {
	out := make([]string, len(specs))
	for i, s := range specs {
		out[i] = s.key
	}
	return out
}

// lookup finds the spec of a key, including the open "models.<tier>" keys.
func lookup(key string) (spec, bool) {
	for _, s := range specs {
		if s.key == key {
			return s, true
		}
	}
	if tier, ok := strings.CutPrefix(key, "models."); ok && tier != "" && !strings.Contains(tier, ".") {
		return spec{key: key, kind: kString}, true
	}
	return spec{}, false
}
