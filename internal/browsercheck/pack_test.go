package browsercheck

import (
	"os"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestPackDeclaresCheck(t *testing.T) {
	data, err := os.ReadFile("../../packs/checks/browser/pack.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var p map[string]string
	if err := yaml.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"name", "kind", "command", "steps_file", "out_dir", "gate"} {
		if p[k] == "" {
			t.Errorf("pack.yaml lacks %q", k)
		}
	}
	if p["kind"] != "check" || p["gate"] != "browser" {
		t.Errorf("kind %q gate %q", p["kind"], p["gate"])
	}
}
