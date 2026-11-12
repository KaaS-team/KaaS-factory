package packs_test

import (
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/KaaS-team/factory/internal/graph"
)

const (
	workflowsDir = "workflows"
	skillsDir    = "../template/.claude/skills"
)

var wantPacks = []string{"dep-upgrade", "framework-upgrade", "migration", "coverage-ramp", "bugfix", "review-only", "onboarding"}

// blueprintPins lists skills the blueprint pins that are not in the template. None yet.
var blueprintPins = []string{}

var tiers = []string{"none", "light", "standard", "deep"}

var modelName = regexp.MustCompile(`(?i)\b(claude|opus|sonnet|haiku|fable|gpt[-\w.]*|gemini|llama|mistral|o[134]-\w+)\b`)

type meta struct {
	Agents map[string]struct {
		Tier   string `yaml:"tier"`
		Budget struct {
			Turns   *int `yaml:"turns"`
			Minutes int  `yaml:"minutes"`
		} `yaml:"budget"`
		Skills []string `yaml:"skills"`
	} `yaml:"agents"`
}

func load(t *testing.T, name string) (*graph.Graph, meta, string) {
	t.Helper()
	path := filepath.Join(workflowsDir, name+".yml")
	g, err := graph.Load(path)
	if err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var m meta
	if err := yaml.Unmarshal(data, &m); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
	return g, m, string(data)
}

func TestSevenPacksLoadThroughGraph(t *testing.T) {
	all, err := graph.LoadDir(workflowsDir)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != len(wantPacks) {
		t.Errorf("want exactly %d workflows, found %d", len(wantPacks), len(all))
	}
	for _, name := range wantPacks {
		g, _, text := load(t, name)
		if g.Name != name || g.Start == "" {
			t.Errorf("%s: name %q start %q", name, g.Name, g.Start)
		}
		if !strings.HasPrefix(text, "# ") || !strings.Contains(strings.SplitN(text, "\n\n", 2)[0], "Use ") {
			t.Errorf("%s: want a header comment that starts \"# Use\"", name)
		}
	}
}

// reaches reports whether to is reachable from from along any edge.
func reaches(g *graph.Graph, from, to string) bool {
	seen := map[string]bool{}
	var walk func(string) bool
	walk = func(id string) bool {
		for _, e := range g.Edges() {
			if e.From != id || seen[e.To] {
				continue
			}
			if e.To == to {
				return true
			}
			seen[e.To] = true
			if walk(e.To) {
				return true
			}
		}
		return false
	}
	return walk(from)
}

func TestBuildIsFollowedByFreshVerify(t *testing.T) {
	for _, name := range wantPacks {
		g, _, _ := load(t, name)
		for _, b := range g.Nodes() {
			if b.Uses != "build" {
				continue
			}
			ok := false
			for _, v := range g.Nodes() {
				if v.Verify && v.FreshSession && reaches(g, b.ID, v.ID) {
					ok = true
				}
			}
			if !ok {
				t.Errorf("%s: build node %s has no later fresh-session verify node", name, b.ID)
			}
		}
	}
}

func TestEveryNodeNamesTierAndBudget(t *testing.T) {
	for _, name := range wantPacks {
		g, m, _ := load(t, name)
		ids := map[string]bool{}
		for _, n := range g.Nodes() {
			if n.Kind == graph.KindFanout || n.Kind == graph.KindHuman {
				continue
			}
			ids[n.ID] = true
			a, ok := m.Agents[n.ID]
			switch {
			case !ok:
				t.Errorf("%s: node %s has no agents entry", name, n.ID)
			case !slices.Contains(tiers, a.Tier):
				t.Errorf("%s: node %s tier %q not one of %v", name, n.ID, a.Tier, tiers)
			case a.Budget.Turns == nil || a.Budget.Minutes <= 0:
				t.Errorf("%s: node %s needs a budget with turns and minutes", name, n.ID)
			case n.Kind == graph.KindAgent && (a.Tier == "none" || *a.Budget.Turns <= 0):
				t.Errorf("%s: agent node %s needs a real tier and turn budget", name, n.ID)
			}
		}
		for id := range m.Agents {
			if !ids[id] {
				t.Errorf("%s: agents entry %q names no node", name, id)
			}
		}
	}
}

func TestEverySkillExists(t *testing.T) {
	for _, name := range wantPacks {
		_, m, _ := load(t, name)
		for id, a := range m.Agents {
			for _, s := range a.Skills {
				if _, err := os.Stat(filepath.Join(skillsDir, s, "SKILL.md")); err != nil && !slices.Contains(blueprintPins, s) {
					t.Errorf("%s: node %s names unknown skill %q", name, id, s)
				}
			}
		}
	}
}

func TestNoModelNames(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(workflowsDir, "*"))
	if len(files) == 0 {
		t.Fatal("no workflow files")
	}
	for _, f := range files {
		data, _ := os.ReadFile(f)
		if m := modelName.FindString(string(data)); m != "" {
			t.Errorf("%s: contains model name %q", f, m)
		}
	}
}

func TestFanoutPacksJoinBeforeGate(t *testing.T) {
	for _, name := range []string{"migration", "framework-upgrade"} {
		g, _, _ := load(t, name)
		var fan graph.Node
		for _, n := range g.Nodes() {
			if n.Kind == graph.KindFanout {
				fan = n
			}
		}
		if fan.ID == "" {
			t.Fatalf("%s: no fanout node", name)
		}
		branches, _ := g.Branches(fan.ID)
		if len(branches) < 2 {
			t.Fatalf("%s: fanout has %d branches", name, len(branches))
		}
		join := ""
		for _, b := range branches {
			to, err := g.Next(b, graph.Pass)
			if err != nil || (join != "" && to != join) {
				t.Fatalf("%s: branch %s goes to %q (%v), want one join", name, b, to, err)
			}
			join = to
		}
		n, _ := g.Node(join)
		if n.Kind != graph.KindCheck || !strings.Contains(n.Run, "gates.sh") {
			t.Errorf("%s: join %s must be the gate check", name, join)
		}
	}
}

func TestCoverageRampLoopsOnCheck(t *testing.T) {
	g, _, _ := load(t, "coverage-ramp")
	n, _ := g.Node("coverage")
	if n.Kind != graph.KindCheck || !strings.Contains(n.Run, "coverage.txt") ||
		!strings.Contains(n.Run, "COVERAGE_TARGET") || !strings.Contains(n.Run, "COVERAGE_MAX_STEPS") {
		t.Fatalf("coverage node must be a check reading the number with a target and a step limit: %+v", n)
	}
	if to, err := g.Next("coverage", graph.Fail); err != nil || to != "build" {
		t.Errorf("below target must loop to build, got %q %v", to, err)
	}
	if to, err := g.Next("coverage", graph.Pass); err != nil || to != "verify" {
		t.Errorf("target reached must go to verify, got %q %v", to, err)
	}
}
