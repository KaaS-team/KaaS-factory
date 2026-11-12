package config

import (
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
)

func readFixture(t *testing.T, rel string) Source {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "factory-config", rel))
	if err != nil {
		t.Fatal(err)
	}
	return Source{Name: rel, Data: data}
}

func TestFactoryConfigFixtures_OrgAndEveryTeamLoad(t *testing.T) {
	teams, err := filepath.Glob(filepath.Join("testdata", "factory-config", "teams", "*.yml"))
	if err != nil || len(teams) == 0 {
		t.Fatalf("no team fixtures: %v", err)
	}
	t.Run("org alone", func(t *testing.T) {
		got, err := Load(Sources{Org: readFixture(t, "org.yml")})
		if err != nil {
			t.Fatalf("Load: %v", err)
		}
		for key, want := range map[string]any{
			"risk_max": "medium", "auto_merge": true, "auto_merge_max_risk": "low",
			"requester_cannot_approve": true, "budgets.month": 200.0,
		} {
			ex, _ := got.Explain(key)
			if ex.Winner != LayerOrg || ex.Value != want {
				t.Errorf("%s = %v from %s, want %v from org", key, ex.Value, ex.Winner, want)
			}
		}
		if ex, _ := got.Explain("models_allowed"); len(ex.Value.([]string)) != 3 || ex.Winner != LayerOrg {
			t.Errorf("models_allowed = %v from %s", ex.Value, ex.Winner)
		}
	})
	for _, p := range teams {
		rel, _ := filepath.Rel(filepath.Join("testdata", "factory-config"), p)
		t.Run(rel, func(t *testing.T) {
			if _, err := Load(Sources{Org: readFixture(t, "org.yml"), Team: readFixture(t, rel)}); err != nil {
				t.Fatalf("Load: %v", err)
			}
		})
	}
}

func TestFactoryConfigFixtures_TeamPolicyCanTightenButNotLoosen(t *testing.T) {
	got, err := Load(Sources{Org: readFixture(t, "org.yml"), Team: readFixture(t, "teams/site.yml")})
	if err != nil {
		t.Fatal(err)
	}
	if ex, _ := got.Explain("auto_merge"); ex.Value != false || ex.Winner != LayerTeam {
		t.Fatalf("auto_merge = %v from %s, want false from team", ex.Value, ex.Winner)
	}
	loose := Source{Name: "loose.yml", Data: []byte("policy:\n  risk_max: high\n")}
	if _, err := Load(Sources{Org: readFixture(t, "org.yml"), Team: loose}); err == nil {
		t.Fatal("a team raising risk_max above the org must fail")
	}
}

func TestReadRepo(t *testing.T) {
	tests := []struct {
		name     string
		files    fstest.MapFS
		wantName string
		wantData string
	}{
		{"yaml", fstest.MapFS{".factory/factory.yaml": {Data: []byte("slots: 2\n")}}, ".factory/factory.yaml", "slots: 2\n"},
		{"json alias", fstest.MapFS{".factory/config.json": {Data: []byte(`{"slots": 3}`)}}, ".factory/config.json", `{"slots": 3}`},
		{"yaml wins over json", fstest.MapFS{
			".factory/factory.yaml": {Data: []byte("slots: 2\n")},
			".factory/config.json":  {Data: []byte(`{"slots": 3}`)},
		}, ".factory/factory.yaml", "slots: 2\n"},
		{"neither", fstest.MapFS{}, "", ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			src, err := ReadRepo(tc.files)
			if err != nil {
				t.Fatal(err)
			}
			if src.Name != tc.wantName || string(src.Data) != tc.wantData {
				t.Fatalf("src = %q %q, want %q %q", src.Name, src.Data, tc.wantName, tc.wantData)
			}
		})
	}
}

func TestReadRepo_JSONAliasLoadsAsRepoLayer(t *testing.T) {
	src, err := ReadRepo(fstest.MapFS{".factory/config.json": {Data: []byte(`{"slots": 3, "budgets": {"node": 2}, "agents": ["claude"]}`)}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := Load(Sources{Repo: src})
	if err != nil {
		t.Fatal(err)
	}
	if ex, _ := got.Explain("slots"); ex.Winner != LayerRepo || ex.Value != 3 {
		t.Fatalf("slots = %v from %s", ex.Value, ex.Winner)
	}
	if got.Config.Budgets.Node != 2 {
		t.Fatalf("budgets.node = %v", got.Config.Budgets.Node)
	}
}
