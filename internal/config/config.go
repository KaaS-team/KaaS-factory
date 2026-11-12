// Package config resolves the runner's settings from layered sources: builtin defaults, the org,
// team and repo files, FACTORY_* environment variables and flags, later layers winning. The org
// layer is a ceiling that the layers below it can lower but never raise.
package config

import (
	"reflect"
	"strings"
	"time"
)

// Budgets caps spend at the node, ticket, team-day and month level. Zero means no cap.
type Budgets struct {
	Node    float64 `key:"node"`
	Ticket  float64 `key:"ticket"`
	TeamDay float64 `key:"team_day"`
	Month   float64 `key:"month"`
}

// Trust says who may run /factory chatops: logins in Allow, and anyone whose role is at least MinRole.
type Trust struct {
	MinRole string   `key:"min_role"`
	Allow   []string `key:"allow"`
}

// Config is the resolved runner configuration. The key tags are the paths used in
// .factory/factory.yaml, in FACTORY_* variable names and in flag names.
type Config struct {
	Repo                   string            `key:"repo"`
	Tracker                string            `key:"tracker"`
	Approval               string            `key:"approval"`
	Dispatcher             string            `key:"dispatcher"`
	Slots                  int               `key:"slots"`
	Workflow               string            `key:"workflow"`
	Agents                 []string          `key:"agents"`
	Packs                  []string          `key:"packs"`
	Budgets                Budgets           `key:"budgets"`
	MergeMode              string            `key:"merge_mode"`
	BatchSize              int               `key:"batch_size"`
	StallAfter             time.Duration     `key:"stall_after"`
	Models                 map[string]string `key:"models"`
	ModelsAllowed          []string          `key:"models_allowed"`
	Base                   string            `key:"base"`
	PollInterval           time.Duration     `key:"poll_interval"`
	StageTimeout           time.Duration     `key:"stage_timeout"`
	MaxRetries             int               `key:"max_retries"`
	MaxOpenPRs             int               `key:"max_open_prs"`
	Gates                  []string          `key:"gates"`
	ProtectedPaths         []string          `key:"protected_paths"`
	RiskMax                string            `key:"risk_max"`
	AutoMerge              bool              `key:"auto_merge"`
	AutoMergeMaxRisk       string            `key:"auto_merge_max_risk"`
	RequesterCannotApprove bool              `key:"requester_cannot_approve"`
	Shadow                 bool              `key:"shadow"`
	Sandbox                bool              `key:"sandbox"`
	Trust                  Trust             `key:"trust"`
}

// field finds the struct field a key path names. For "models.<tier>" it returns the map and the tier.
func (c *Config) field(key string) (v reflect.Value, tier string, ok bool) {
	v = reflect.ValueOf(c).Elem()
	parts := strings.Split(key, ".")
	for i, p := range parts {
		f, found := byTag(v, p)
		if !found {
			return reflect.Value{}, "", false
		}
		v = f
		if v.Kind() == reflect.Map {
			if i != len(parts)-2 {
				return reflect.Value{}, "", false
			}
			return v, parts[i+1], true
		}
		if v.Kind() == reflect.Struct {
			continue
		}
		return v, "", i == len(parts)-1
	}
	return reflect.Value{}, "", false
}

func byTag(v reflect.Value, tag string) (reflect.Value, bool) {
	t := v.Type()
	for i := range t.NumField() {
		if t.Field(i).Tag.Get("key") == tag {
			return v.Field(i), true
		}
	}
	return reflect.Value{}, false
}

// Get returns the typed value of a key path such as "slots" or "budgets.team_day". It reports false
// for an unknown key and for a "models.<tier>" key with no value.
func (c *Config) Get(key string) (any, bool) {
	v, tier, ok := c.field(key)
	if !ok {
		return nil, false
	}
	if v.Kind() == reflect.Map {
		m := v.MapIndex(reflect.ValueOf(tier))
		if !m.IsValid() {
			return nil, false
		}
		return m.Interface(), true
	}
	return v.Interface(), true
}

// put stores a coerced value at a key path.
func (c *Config) put(key string, val any) bool {
	v, tier, ok := c.field(key)
	if !ok {
		return false
	}
	if v.Kind() == reflect.Map {
		if v.IsNil() {
			v.Set(reflect.MakeMap(v.Type()))
		}
		v.SetMapIndex(reflect.ValueOf(tier), reflect.ValueOf(val))
		return true
	}
	v.Set(reflect.ValueOf(val))
	return true
}
