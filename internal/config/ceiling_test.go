package config

import (
	"errors"
	"fmt"
	"strings"
	"testing"
)

// TestCeiling_OrgBoundsLowerLayers: Symphony §6 leaves config to the implementation; the factory-config
// policy is a ceiling. A lower layer may tighten an org value and never loosen it.
func TestCeiling_OrgBoundsLowerLayers(t *testing.T) {
	tests := []struct {
		key, org, lower string
		ok              bool
	}{
		{"budgets.team_day", "100", "200", false},
		{"budgets.team_day", "100", "50", true},
		{"budgets.team_day", "100", "100", true},
		{"budgets.node", "5", "6", false},
		{"budgets.ticket", "5", "4", true},
		{"budgets.month", "200", "201", false},
		{"slots", "4", "8", false},
		{"slots", "4", "2", true},
		{"batch_size", "4", "5", false},
		{"max_retries", "2", "3", false},
		{"max_open_prs", "3", "4", false},
		{"agents", "[a, b]", "[a, c]", false},
		{"agents", "[a, b]", "[a]", true},
		{"agents", "[a, b]", "[b, a]", true},
		{"agents", "[a, b]", "[]", true},
		{"packs", "[p1]", "[p2]", false},
		{"models_allowed", "[haiku, sonnet]", "[opus]", false},
		{"models_allowed", "[haiku, sonnet]", "[haiku]", true},
		{"risk_max", "medium", "high", false},
		{"risk_max", "medium", "low", true},
		{"risk_max", "medium", "medium", true},
		{"auto_merge_max_risk", "low", "medium", false},
		{"auto_merge_max_risk", "medium", "low", true},
		{"auto_merge", "false", "true", false},
		{"auto_merge", "true", "false", true},
		{"auto_merge", "true", "true", true},
		{"requester_cannot_approve", "true", "false", false},
		{"requester_cannot_approve", "false", "true", true},
		{"requester_cannot_approve", "true", "true", true},
		{"sandbox", "true", "false", false},
		{"sandbox", "false", "true", true},
	}
	for _, tc := range tests {
		for _, l := range []Layer{LayerTeam, LayerRepo, LayerEnv, LayerFlags} {
			t.Run(fmt.Sprintf("%s org=%s %s=%s", tc.key, tc.org, l, tc.lower), func(t *testing.T) {
				var s Sources
				set(t, &s, LayerOrg, tc.key, tc.org)
				set(t, &s, l, tc.key, tc.lower)
				_, err := Load(s)
				if tc.ok {
					if err != nil {
						t.Fatalf("Load: %v", err)
					}
					return
				}
				if !errors.Is(err, ErrCeiling) {
					t.Fatalf("error = %v, want ErrCeiling", err)
				}
				for _, want := range []string{tc.key, "org", string(l) + " layer"} {
					if !strings.Contains(err.Error(), want) {
						t.Fatalf("error %q does not name %q", err, want)
					}
				}
			})
		}
	}
}

func TestCeiling_NoOrgValueMeansNoCeiling(t *testing.T) {
	var s Sources
	set(t, &s, LayerTeam, "budgets.team_day", "100000")
	set(t, &s, LayerRepo, "slots", "64")
	if _, err := Load(s); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestCeiling_UncappedKeysAreFreeBelowTheOrg(t *testing.T) {
	var s Sources
	set(t, &s, LayerOrg, "workflow", "w1")
	set(t, &s, LayerTeam, "workflow", "w2")
	if _, err := Load(s); err != nil {
		t.Fatalf("Load: %v", err)
	}
}

func TestCeiling_ReportsEveryViolation(t *testing.T) {
	s := Sources{
		Org:  Source{Name: "org.yml", Data: []byte("slots: 2\nbudgets:\n  team_day: 10\n")},
		Team: Source{Name: "core.yml", Data: []byte("slots: 9\nbudgets:\n  team_day: 99\n")},
	}
	_, err := Load(s)
	if err == nil || !strings.Contains(err.Error(), "slots") || !strings.Contains(err.Error(), "budgets.team_day") {
		t.Fatalf("error = %v, want both keys", err)
	}
}

func TestCeiling_FactoryConfigOrgPolicyBoundsTeams(t *testing.T) {
	org := Source{Name: "org.yml", Data: []byte("policy:\n  budget_usd_month: 200\n  models: [haiku, sonnet]\n")}
	team := Source{Name: "core.yml", Data: []byte("policy:\n  budget_usd_month: 300\n")}
	_, err := Load(Sources{Org: org, Team: team})
	if !errors.Is(err, ErrCeiling) || !strings.Contains(err.Error(), "budgets.month") {
		t.Fatalf("error = %v, want a ceiling error on budgets.month", err)
	}
}
