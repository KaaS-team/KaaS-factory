package graph

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

const keysHead = "name: w\nsteps:\n"

// A node carries tier, budget and skills; a wrong type fails naming the key and the file line.
func TestNodeAgentKeys(t *testing.T) {
	cases := []struct {
		name, step string
		want       Node
		errHas     []string
	}{
		{"tier small", "  a: { uses: build, tier: small }\n", Node{Tier: "small"}, nil},
		{"tier large", "  a: { uses: build, tier: large }\n", Node{Tier: "large"}, nil},
		{"budget", "  a: { uses: build, budget: 40000 }\n", Node{Budget: 40000}, nil},
		{"skills", "  a: { uses: build, skills: [factory-build, factory-plan] }\n", Node{Skills: []string{"factory-build", "factory-plan"}}, nil},
		{"all three", "  a:\n    uses: build\n    tier: large\n    budget: 9\n    skills: [x]\n", Node{Tier: "large", Budget: 9, Skills: []string{"x"}}, nil},
		{"tier unknown", "  a:\n    uses: build\n    tier: huge\n", Node{}, []string{`step a`, `line 5`, `key "tier"`}},
		{"tier not text", "  a:\n    uses: build\n    tier: [small]\n", Node{}, []string{`line 5`, `key "tier"`}},
		{"budget text", "  a:\n    uses: build\n    tier: small\n    budget: lots\n", Node{}, []string{`line 6`, `key "budget"`}},
		{"budget float", "  a: { uses: build, budget: 1.5 }\n", Node{}, []string{`line 3`, `key "budget"`}},
		{"budget zero", "  a: { uses: build, budget: 0 }\n", Node{}, []string{`line 3`, `key "budget"`}},
		{"skills scalar", "  a:\n    uses: build\n    skills: factory-build\n", Node{}, []string{`line 5`, `key "skills"`}},
		{"skills nested", "  a:\n    uses: build\n    skills: [a, [b]]\n", Node{}, []string{`line 5`, `key "skills"`}},
		{"skills empty name", "  a:\n    uses: build\n    skills: ['']\n", Node{}, []string{`line 5`, `key "skills"`}},
		{"on a check", "  a: { uses: check, run: make, tier: small }\n", Node{}, []string{`step a`, `line 3`, `key "tier"`}},
		{"unknown key still fails", "  a: { uses: build, tears: 1 }\n", Node{}, []string{`unknown key "tears"`}},
	}
	for _, c := range cases {
		g, err := ParseYAML("w", []byte(keysHead+c.step))
		if len(c.errHas) > 0 {
			for _, h := range c.errHas {
				if err == nil || !strings.Contains(err.Error(), h) {
					t.Errorf("%s: got %v, want %q", c.name, err, h)
				}
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		n, _ := g.Node("a")
		if n.Tier != c.want.Tier || n.Budget != c.want.Budget || !reflect.DeepEqual(n.Skills, c.want.Skills) {
			t.Errorf("%s: tier %q budget %d skills %v", c.name, n.Tier, n.Budget, n.Skills)
		}
		if len(g.Warnings) != 0 {
			t.Errorf("%s: warnings %v", c.name, g.Warnings)
		}
	}
}

// In a markdown workflow the line is the line in the file, front matter fence included.
func TestNodeKeyErrorLineInMarkdown(t *testing.T) {
	src := "---\nname: w\nnodes:\n  a:\n    uses: build\n    budget: lots\n---\nbody\n"
	_, err := LoadMarkdown(writeFile(t, t.TempDir(), "w.md", src))
	if err == nil || !strings.Contains(err.Error(), `line 6`) || !strings.Contains(err.Error(), `key "budget"`) {
		t.Errorf("got %v", err)
	}
}

// The old top-level agents map still loads for one release and comes back as a warning.
func TestOldAgentsMapStillLoadsWithWarning(t *testing.T) {
	old := "name: w\nagents:\n  a: { tier: deep, budget: { turns: 5, minutes: 5 }, skills: [s1] }\n  b: { tier: light }\n  c: { tier: none }\nsteps:\n" +
		"  a: { uses: build, next: b }\n  b: { uses: pr, next: c }\n  c: { uses: check, run: make }\n"
	g, err := ParseYAML("w", []byte(old))
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Warnings) != 1 || !strings.Contains(g.Warnings[0], "agents") || !strings.Contains(g.Warnings[0], "deprecated") {
		t.Errorf("warnings %v", g.Warnings)
	}
	a, _ := g.Node("a")
	b, _ := g.Node("b")
	c, _ := g.Node("c")
	if a.Tier != "large" || !reflect.DeepEqual(a.Skills, []string{"s1"}) || b.Tier != "small" || c.Tier != "" {
		t.Errorf("a %+v b %+v c %+v", a, b, c)
	}
	// A node key wins over the old map.
	mixed := "agents:\n  a: { tier: deep, skills: [old] }\nsteps:\n  a: { uses: build, tier: small, skills: [new] }\n"
	g, err = ParseYAML("w", []byte(mixed))
	if err != nil {
		t.Fatal(err)
	}
	a, _ = g.Node("a")
	if a.Tier != "small" || !reflect.DeepEqual(a.Skills, []string{"new"}) {
		t.Errorf("a %+v", a)
	}
	// An entry naming no step is an error naming it.
	if _, err := ParseYAML("w", []byte("agents:\n  zz: { tier: small }\nsteps:\n  a: { uses: build }\n")); err == nil || !strings.Contains(err.Error(), `"zz"`) {
		t.Errorf("got %v", err)
	}
}

// Golden: an unknown template variable in a node prompt names the variable, the step and the file line.
func TestUnknownVariableErrorGolden(t *testing.T) {
	cases := map[string]func() error{
		"unknown-var-yaml": func() error {
			_, err := ParseYAML("w", []byte("name: w\nsteps:\n  triage:\n    uses: triage\n    prompt: |\n      Look at {{ issue.title }}\n      and {{ repo_name }}\n"))
			return err
		},
		"unknown-var-markdown": func() error {
			src := "---\nname: w\nnodes:\n  triage:\n    uses: triage\n    prompt: \"see {{ ticket.titel }}\"\n---\nbody\n"
			_, err := LoadMarkdown(writeFile(t, t.TempDir(), "w.md", src))
			return err
		},
	}
	for name, run := range cases {
		err := run()
		if err == nil {
			t.Fatalf("%s: no error", name)
		}
		want, rerr := os.ReadFile(filepath.Join("testdata", name+".golden"))
		if rerr != nil {
			t.Fatal(rerr)
		}
		if got := err.Error() + "\n"; got != string(want) {
			t.Errorf("%s:\n got %q\nwant %q", name, got, want)
		}
	}
}
