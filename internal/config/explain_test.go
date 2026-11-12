package config

import (
	"reflect"
	"strings"
	"testing"
)

func TestExplain_SlotsNamesWinnerAndOverriddenLayers(t *testing.T) {
	s := Sources{
		Org:  Source{Name: "org.yml", Data: []byte("slots: 8\n")},
		Team: Source{Name: "core.yml", Data: []byte("slots: 5\n")},
		Repo: Source{Name: "factory.yaml", Data: []byte("slots: 4\n")},
		Env:  []string{"FACTORY_SLOTS=3", "HOME=/x"},
	}
	got, err := Load(s)
	if err != nil {
		t.Fatal(err)
	}
	ex, err := got.Explain("slots")
	if err != nil {
		t.Fatal(err)
	}
	if ex.Value != 3 || ex.Winner != LayerEnv {
		t.Fatalf("value %v winner %s, want 3 from env", ex.Value, ex.Winner)
	}
	wantOver := []Layer{LayerBuiltin, LayerOrg, LayerTeam, LayerRepo}
	if !reflect.DeepEqual(ex.Overrode, wantOver) {
		t.Fatalf("overrode = %v, want %v", ex.Overrode, wantOver)
	}
	wantTried := []Attempt{
		{LayerBuiltin, 6, ""}, {LayerOrg, 8, "org.yml"}, {LayerTeam, 5, "core.yml"},
		{LayerRepo, 4, "factory.yaml"}, {LayerEnv, 3, ""},
	}
	if !reflect.DeepEqual(ex.Tried, wantTried) {
		t.Fatalf("tried = %v, want %v", ex.Tried, wantTried)
	}
	if line := ex.String(); !strings.Contains(line, "slots = 3 (env)") || !strings.Contains(line, "overrode builtin, org, team, repo") {
		t.Fatalf("String() = %q", line)
	}
}

func TestExplain_BuiltinWinnerOverridesNothing(t *testing.T) {
	got, _ := Load(Sources{})
	ex, err := got.Explain("slots")
	if err != nil || ex.Winner != LayerBuiltin || len(ex.Overrode) != 0 || ex.Value != 6 {
		t.Fatalf("ex = %+v, err %v", ex, err)
	}
}

func TestExplain_ModelTierAndUnsetAndUnknown(t *testing.T) {
	got, _ := Load(Sources{Repo: Source{Name: "factory.yaml", Data: []byte("models:\n  fast: m1\n")}})
	if ex, err := got.Explain("models.fast"); err != nil || ex.Winner != LayerRepo || ex.Value != "m1" {
		t.Fatalf("ex = %+v, err %v", ex, err)
	}
	if ex, err := got.Explain("models.slow"); err != nil || ex.Winner != "" || ex.Value != nil || len(ex.Tried) != 0 {
		t.Fatalf("unset tier: ex = %+v, err %v", ex, err)
	}
	if _, err := got.Explain("nope"); err == nil || !strings.Contains(err.Error(), `"nope"`) {
		t.Fatalf("err = %v, want unknown key", err)
	}
}
