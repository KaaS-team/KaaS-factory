package graph

import (
	"strings"
	"testing"
)

// Pins the exact error text of the import and build paths, so splitting those functions cannot change it.
func TestPinImportErrors(t *testing.T) {
	d := t.TempDir()
	put(t, d, "bad.md", "---\non: manual\n---\nB\n")
	put(t, d, "list.md", "---\nimports: x\n---\nB\n")
	put(t, d, "map.md", "---\n- a\n---\nB\n")
	put(t, d, "var.md", "---\n---\n{{ nope }}\n")
	put(t, d, "yaml.md", "---\na: [\n---\nB\n")
	put(t, d, "safe.md", "---\nsafe_outputs: [zzz]\n---\nB\n")
	put(t, d, "a.md", "---\nimports: [b.md]\n---\nA\n")
	put(t, d, "b.md", "---\nimports: [a.md]\n---\nB\n")
	cases := map[string]string{
		"import-own-key": "import bad.md: key \"on\" is not allowed in an imported file",
		"nested-list":    "w: imports must be a list of file paths",
		"not-a-map":      "import map.md: ",
		"bad-var":        "import var.md: ",
		"bad-yaml":       "import yaml.md: workflow_parse_error: ",
		"bad-safe":       "import safe.md: ",
		"cycle":          "w: import cycle: a.md -> b.md -> a.md",
		"missing":        "import nope.md: ",
		"outside":        "import \"../x.md\" must be a relative path inside its own directory",
	}
	files := map[string]string{
		"import-own-key": "bad.md", "nested-list": "list.md", "not-a-map": "map.md", "bad-var": "var.md",
		"bad-yaml": "yaml.md", "bad-safe": "safe.md", "cycle": "a.md", "missing": "nope.md", "outside": "../x.md",
	}
	for name, want := range cases {
		t.Run(name, func(t *testing.T) {
			p := put(t, d, "w.md", "---\nimports: ["+files[name]+"]\n---\nM\n")
			_, err := LoadMarkdown(p)
			if err == nil || !strings.Contains(err.Error(), want) {
				t.Fatalf("want %q, got %v", want, err)
			}
		})
	}
}

func TestPinBuildErrors(t *testing.T) {
	cases := map[string][2]string{
		"not-a-map":  {"steps: [a]\n", "w: \"steps\" must be a map with at least one step"},
		"empty-map":  {"steps: {}\n", "w: \"steps\" must be a map with at least one step"},
		"step-array": {"steps:\n  a: [x]\n", "w: step a must be a map"},
		"bad-key":    {"steps:\n  a:\n    usess: agent\n", "w: step a: unknown key \"usess\""},
	}
	for name, c := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := ParseYAML("w", []byte(c[0]))
			if err == nil || !strings.Contains(err.Error(), c[1]) {
				t.Fatalf("want %q, got %v", c[1], err)
			}
		})
	}
}
