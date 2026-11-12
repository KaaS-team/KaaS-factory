package config

import (
	"fmt"
	"strings"
	"testing"

	"github.com/spf13/pflag"
)

// layerRow gives, for one key, a higher and a lower value in the sense of its ceiling, so a lower
// layer holding "lo" always sits within an org ceiling of "hi".
type layerRow struct {
	key, hi, lo string // YAML scalar or flow list forms
	wantHi      string // fmt.Sprint of the typed value; empty means the same as hi
	wantLo      string
	clamped     bool // the org layer clamps this key, so a layer directly above it does not win over it
}

var layerRows = []layerRow{
	{key: "repo", hi: "a/b", lo: "c/d"},
	{key: "tracker", hi: "linear", lo: "jira"},
	{key: "approval", hi: "human", lo: "auto"},
	{key: "dispatcher", hi: "local", lo: "cloud"},
	{key: "slots", hi: "5", lo: "2"},
	{key: "workflow", hi: "w1", lo: "w2"},
	{key: "agents", hi: "[a, b]", lo: "[a]", wantHi: "[a b]", wantLo: "[a]"},
	{key: "packs", hi: "[p1, p2]", lo: "[p1]", wantHi: "[p1 p2]", wantLo: "[p1]"},
	{key: "budgets.node", hi: "9", lo: "4"},
	{key: "budgets.ticket", hi: "9", lo: "4"},
	{key: "budgets.team_day", hi: "9", lo: "4"},
	{key: "budgets.month", hi: "9", lo: "4"},
	{key: "merge_mode", hi: "direct", lo: "host"},
	{key: "batch_size", hi: "4", lo: "2"},
	{key: "stall_after", hi: "30m", lo: "10m", wantHi: "30m0s", wantLo: "10m0s"},
	{key: "models_allowed", hi: "[haiku, sonnet]", lo: "[haiku]", wantHi: "[haiku sonnet]", wantLo: "[haiku]"},
	{key: "models.fast", hi: "m1", lo: "m2"},
	{key: "base", hi: "develop", lo: "dev"},
	{key: "poll_interval", hi: "30s", lo: "5s", wantHi: "30s", wantLo: "5s"},
	{key: "stage_timeout", hi: "30m", lo: "10m", wantHi: "30m0s", wantLo: "10m0s"},
	{key: "max_retries", hi: "2", lo: "1"},
	{key: "max_open_prs", hi: "5", lo: "2"},
	{key: "gates", hi: "[g1, g2]", lo: "[g1]", wantHi: "[g1 g2]", wantLo: "[g1]"},
	{key: "protected_paths", hi: "[x/**, y/**]", lo: "[x/**]", wantHi: "[x/** y/**]", wantLo: "[x/**]"},
	{key: "risk_max", hi: "medium", lo: "low"},
	{key: "auto_merge", hi: "true", lo: "false"},
	{key: "auto_merge_max_risk", hi: "high", lo: "medium"},
	{key: "requester_cannot_approve", hi: "false", lo: "true"},
	{key: "shadow", hi: "true", lo: "false", clamped: true},
	{key: "trust.min_role", hi: "maintain", lo: "triage", clamped: true},
	{key: "trust.allow", hi: "[alice, bob]", lo: "[alice]", wantHi: "[alice bob]", wantLo: "[alice]"},
}

func yamlFor(key, val string) []byte {
	parts := strings.Split(key, ".")
	var b strings.Builder
	for i, p := range parts {
		b.WriteString(strings.Repeat("  ", i) + p + ":")
		if i == len(parts)-1 {
			b.WriteString(" " + val)
		}
		b.WriteString("\n")
	}
	return []byte(b.String())
}

func envName(key string) string {
	return "FACTORY_" + strings.ToUpper(strings.ReplaceAll(key, ".", "_"))
}

// plain turns a flow list into the comma form env and flags use.
func plain(v string) string {
	return strings.ReplaceAll(strings.Trim(v, "[]"), ", ", ",")
}

// set puts value val for key at layer l into the sources.
func set(t *testing.T, s *Sources, l Layer, key, val string) {
	t.Helper()
	switch l {
	case LayerOrg:
		s.Org = Source{Name: "org.yml", Data: yamlFor(key, val)}
	case LayerTeam:
		s.Team = Source{Name: "team.yml", Data: yamlFor(key, val)}
	case LayerRepo:
		s.Repo = Source{Name: "factory.yaml", Data: yamlFor(key, val)}
	case LayerEnv:
		s.Env = append(s.Env, envName(key)+"="+plain(val))
	case LayerFlags:
		if s.Flags == nil {
			s.Flags = pflag.NewFlagSet("t", pflag.ContinueOnError)
			RegisterFlags(s.Flags)
		}
		if err := s.Flags.Set(key, plain(val)); err != nil {
			t.Fatalf("flag %s: %v", key, err)
		}
	default:
		t.Fatalf("cannot set layer %s", l)
	}
}

// TestLayering_EachLayerWinsOverTheOneBelow: Symphony §6 (config precedence, layered over the
// workflow file). For every key, setting it at a layer beats the same key at the layer below.
func TestLayering_EachLayerWinsOverTheOneBelow(t *testing.T) {
	order := []Layer{LayerOrg, LayerTeam, LayerRepo, LayerEnv, LayerFlags}
	for _, row := range layerRows {
		wantHi, wantLo := row.wantHi, row.wantLo
		if wantHi == "" {
			wantHi = row.hi
		}
		if wantLo == "" {
			wantLo = row.lo
		}
		for i, l := range order {
			t.Run(fmt.Sprintf("%s/%s", row.key, l), func(t *testing.T) {
				if row.clamped && i == 1 {
					t.Skip("org clamps this key; see TestShadowTrust_LayerTable")
				}
				var s Sources
				if i > 0 {
					set(t, &s, order[i-1], row.key, row.hi)
				}
				set(t, &s, l, row.key, row.lo)
				got, err := Load(s)
				if err != nil {
					t.Fatalf("Load: %v", err)
				}
				v, ok := got.Config.Get(row.key)
				if !ok || fmt.Sprint(v) != wantLo {
					t.Fatalf("value = %v, want %s", v, wantLo)
				}
				ex, err := got.Explain(row.key)
				if err != nil {
					t.Fatal(err)
				}
				if ex.Winner != l {
					t.Fatalf("winner = %s, want %s", ex.Winner, l)
				}
			})
		}
		t.Run(row.key+"/lower alone", func(t *testing.T) {
			var s Sources
			set(t, &s, LayerOrg, row.key, row.hi)
			got, err := Load(s)
			if err != nil {
				t.Fatal(err)
			}
			if v, _ := got.Config.Get(row.key); fmt.Sprint(v) != wantHi {
				t.Fatalf("value = %v, want %s", v, wantHi)
			}
		})
	}
}

func TestLayering_BuiltinDefaults(t *testing.T) {
	got, err := Load(Sources{})
	if err != nil {
		t.Fatal(err)
	}
	if got.Config.Slots != 6 {
		t.Fatalf("slots default = %d, want 6", got.Config.Slots)
	}
	for _, k := range Keys() {
		if _, ok := got.Config.Get(k); !ok {
			t.Errorf("key %s has no builtin value", k)
		}
	}
	ex, _ := got.Explain("slots")
	if ex.Winner != LayerBuiltin {
		t.Fatalf("winner = %s, want builtin", ex.Winner)
	}
}

func TestLayering_LayerRowsCoverEveryKey(t *testing.T) {
	have := map[string]bool{}
	for _, r := range layerRows {
		have[r.key] = true
	}
	for _, k := range Keys() {
		if !have[k] {
			t.Errorf("layerRows has no row for key %s", k)
		}
	}
}
