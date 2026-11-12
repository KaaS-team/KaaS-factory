package config

import (
	"fmt"
	"time"
)

// KeyInfo describes one config key for generated documentation.
type KeyInfo struct {
	Key     string // key path such as "budgets.node"
	Type    string // string, int, number, duration, list, bool or risk
	Default string // the builtin value as text
	Rule    string // what the org layer lets lower layers do with the key
}

var kindNames = map[kind]string{
	kString: "string", kInt: "int", kFloat: "number", kDuration: "duration",
	kList: "list", kBool: "bool", kRisk: "risk",
}

var ceilRules = map[ceiling]string{
	ceilNone:   "any layer may set it",
	ceilMax:    "org value is a cap; lower layers may lower it, never raise it",
	ceilSubset: "org value is an allow-list; lower layers may only remove entries",
	ceilRisk:   "lower layers may pick a risk at or below the org's",
	ceilFalse:  "when the org sets false, lower layers cannot set true",
	ceilTrue:   "when the org sets true, lower layers cannot set false",
}

// Describe lists every fixed key with its type, builtin default and org ceiling rule, in table order.
func Describe() []KeyInfo {
	out := make([]KeyInfo, len(specs))
	for i, sp := range specs {
		def := fmt.Sprint(sp.def)
		switch v := sp.def.(type) {
		case time.Duration:
			def = v.String()
		case string:
			def = fmt.Sprintf("%q", v)
		}
		out[i] = KeyInfo{Key: sp.key, Type: kindNames[sp.kind], Default: def, Rule: ceilRules[sp.ceil]}
	}
	return out
}
