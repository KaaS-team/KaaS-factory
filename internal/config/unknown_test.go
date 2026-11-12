package config

import (
	"strings"
	"testing"

	"github.com/spf13/pflag"
)

func TestUnknownKey_FailsWithFullPathInEveryLayer(t *testing.T) {
	yamlCase := func(layer Layer, doc string) Sources {
		var s Sources
		src := Source{Name: string(layer) + ".yml", Data: []byte(doc)}
		switch layer {
		case LayerOrg:
			s.Org = src
		case LayerTeam:
			s.Team = src
		default:
			s.Repo = src
		}
		return s
	}
	flagCase := func() Sources {
		fs := pflag.NewFlagSet("t", pflag.ContinueOnError)
		RegisterFlags(fs)
		fs.String("budgets.weekly", "", "")
		_ = fs.Set("budgets.weekly", "3")
		return Sources{Flags: fs}
	}
	tests := []struct {
		name string
		src  Sources
		want string
	}{
		{"org top level", yamlCase(LayerOrg, "slotz: 3\n"), `"slotz"`},
		{"team nested", yamlCase(LayerTeam, "budgets:\n  weekly: 3\n"), `"budgets.weekly"`},
		{"repo nested", yamlCase(LayerRepo, "budgets:\n  node: 1\n  weekly: 3\n"), `"budgets.weekly"`},
		{"repo scalar where a table is expected", yamlCase(LayerRepo, "budgets: 5\n"), `"budgets"`},
		{"repo table where a scalar is expected", yamlCase(LayerRepo, "slots:\n  max: 3\n"), `"slots.max"`},
		{"repo rejects org-only metadata", yamlCase(LayerRepo, "mission: x\n"), `"mission"`},
		{"org unknown policy key", yamlCase(LayerOrg, "policy:\n  speed: 1\n"), `"policy.speed"`},
		{"unknown key with a null value", yamlCase(LayerRepo, "bogus:\n"), `"bogus"`},
		{"env", Sources{Env: []string{"FACTORY_BOGUS_KEY=1"}}, `"bogus_key"`},
		{"flags", flagCase(), `"budgets.weekly"`},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(tc.src)
			if err == nil {
				t.Fatal("Load succeeded, want an unknown key error")
			}
			if !strings.Contains(err.Error(), "unknown key "+tc.want) {
				t.Fatalf("error %q does not name unknown key %s", err, tc.want)
			}
		})
	}
}

func TestUnknownKey_ReportsEveryOneSorted(t *testing.T) {
	_, err := Load(Sources{Repo: Source{Name: "factory.yaml", Data: []byte("zeta: 1\nalpha: 2\n")}})
	if err == nil {
		t.Fatal("want error")
	}
	msg := err.Error()
	if i, j := strings.Index(msg, `"alpha"`), strings.Index(msg, `"zeta"`); i < 0 || j < 0 || i > j {
		t.Fatalf("error %q should list alpha then zeta", msg)
	}
}

func TestTypeErrors_NameLayerAndKey(t *testing.T) {
	tests := []struct{ name, doc, want string }{
		{"slots text", "slots: many\n", "slots"},
		{"slots zero", "slots: 0\n", "slots"},
		{"budget negative", "budgets:\n  node: -1\n", "budgets.node"},
		{"duration", "stall_after: soon\n", "stall_after"},
		{"risk", "risk_max: extreme\n", "risk_max"},
		{"bool", "auto_merge: maybe\n", "auto_merge"},
		{"list entry", "agents: [1]\n", "agents"},
		{"string", "repo: 5\n", "repo"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := Load(Sources{Repo: Source{Name: "factory.yaml", Data: []byte(tc.doc)}})
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), "repo layer") {
				t.Fatalf("error = %v, want repo layer and key %s", err, tc.want)
			}
		})
	}
}
