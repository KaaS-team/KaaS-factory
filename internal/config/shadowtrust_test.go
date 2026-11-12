package config

import (
	"strings"
	"testing"
)

// TestShadowTrust_LayerTable: Symphony §6 leaves config to the implementation. The org layer forces
// shadow on and sets the floor of trust.min_role; lower layers resolve to it instead of failing.
func TestShadowTrust_LayerTable(t *testing.T) {
	tests := []struct {
		name     string
		key      string
		org, low string // "" means the layer does not set the key
		lowLayer Layer
		want     any
	}{
		{"shadow default", "shadow", "", "", LayerRepo, false},
		{"org true, repo false", "shadow", "true", "false", LayerRepo, true},
		{"org true, flags false", "shadow", "true", "false", LayerFlags, true},
		{"org unset, repo true", "shadow", "", "true", LayerRepo, true},
		{"org false, repo true", "shadow", "false", "true", LayerRepo, true},
		{"org false, repo false", "shadow", "false", "false", LayerRepo, false},
		{"min_role default", "trust.min_role", "", "", LayerRepo, "write"},
		{"org maintain, repo write", "trust.min_role", "maintain", "write", LayerRepo, "maintain"},
		{"org maintain, env read", "trust.min_role", "maintain", "read", LayerEnv, "maintain"},
		{"org write, repo admin", "trust.min_role", "write", "admin", LayerRepo, "admin"},
		{"org unset, repo triage", "trust.min_role", "", "triage", LayerRepo, "triage"},
		{"org maintain, repo maintain", "trust.min_role", "maintain", "maintain", LayerRepo, "maintain"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var s Sources
			if tc.org != "" {
				set(t, &s, LayerOrg, tc.key, tc.org)
			}
			if tc.low != "" {
				set(t, &s, tc.lowLayer, tc.key, tc.low)
			}
			l, err := Load(s)
			if err != nil {
				t.Fatalf("Load: %v", err)
			}
			if got, _ := l.Config.Get(tc.key); got != tc.want {
				t.Fatalf("%s = %v, want %v", tc.key, got, tc.want)
			}
		})
	}
}

func TestShadowTrust_ExplainNamesTheOrgWhenItClamps(t *testing.T) {
	var s Sources
	set(t, &s, LayerOrg, "trust.min_role", "maintain")
	set(t, &s, LayerRepo, "trust.min_role", "write")
	l, err := Load(s)
	if err != nil {
		t.Fatal(err)
	}
	if ex, _ := l.Explain("trust.min_role"); ex.Winner != LayerOrg || ex.Value != "maintain" {
		t.Fatalf("explain = %v", ex)
	}
}

func TestShadowTrust_Allow(t *testing.T) {
	l, err := Load(Sources{Repo: Source{Name: "factory.yaml", Data: []byte("trust:\n  allow: [alice, bob]\n")}})
	if err != nil {
		t.Fatal(err)
	}
	if got := l.Config.Trust.Allow; len(got) != 2 || got[0] != "alice" || got[1] != "bob" {
		t.Fatalf("allow = %v", got)
	}
	l, _ = Load(Sources{})
	if l.Config.Trust.Allow == nil || len(l.Config.Trust.Allow) != 0 {
		t.Fatalf("default allow = %#v, want empty", l.Config.Trust.Allow)
	}
}

func TestShadowTrust_UnknownValuesNameTheKey(t *testing.T) {
	tests := []struct{ key, val string }{
		{"trust.min_role", "owner"},
		{"trust.min_role", "none"},
		{"shadow", "maybe"},
	}
	for _, tc := range tests {
		for _, l := range []Layer{LayerOrg, LayerRepo, LayerEnv} {
			t.Run(tc.key+"="+tc.val+" "+string(l), func(t *testing.T) {
				var s Sources
				set(t, &s, l, tc.key, tc.val)
				_, err := Load(s)
				want := tc.key
				if l == LayerEnv {
					want = envName(tc.key) // the env layer names the variable, as for every key
				}
				if err == nil || !strings.Contains(err.Error(), want) {
					t.Fatalf("error = %v, want one naming %s", err, want)
				}
			})
		}
	}
}

func TestShadowTrust_DescribeListsTheKeys(t *testing.T) {
	got := map[string]KeyInfo{}
	for _, k := range Describe() {
		got[k.Key] = k
	}
	for key, def := range map[string]string{"shadow": "false", "trust.min_role": `"write"`, "trust.allow": "[]"} {
		k, ok := got[key]
		if !ok || k.Default != def || k.Rule == "" {
			t.Errorf("Describe %s = %+v", key, k)
		}
	}
}
