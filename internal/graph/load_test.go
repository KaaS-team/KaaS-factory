package graph

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const workflowsDir = "../../.factory/workflows"

func TestEveryExistingWorkflowLoads(t *testing.T) {
	files, _ := filepath.Glob(filepath.Join(workflowsDir, "*"))
	if len(files) != 18 {
		t.Fatalf("want 18 workflow files, found %d", len(files))
	}
	for _, f := range files {
		g, err := Load(f)
		if err != nil {
			t.Errorf("%s: %v", filepath.Base(f), err)
			continue
		}
		if g.Start == "" || len(g.Nodes()) == 0 {
			t.Errorf("%s: empty graph", f)
		}
		for _, n := range g.Nodes() {
			if n.Verify && !n.FreshSession {
				t.Errorf("%s: verify node %s has no fresh session", f, n.ID)
			}
		}
	}
}

func TestGoldenGraphs(t *testing.T) {
	for _, name := range []string{"planned-to-pr", "bug-to-pr"} {
		g, err := Load(filepath.Join(workflowsDir, name+".yml"))
		if err != nil {
			t.Fatal(err)
		}
		want, err := os.ReadFile(filepath.Join("testdata", name+".golden"))
		if err != nil {
			t.Fatal(err)
		}
		if got := g.Describe(); got != string(want) {
			t.Errorf("%s changed:\n--- got\n%s--- want\n%s", name, got, want)
		}
	}
}

func TestLoadRefusals(t *testing.T) {
	ok := "name: w\nsteps:\n  triage: { uses: triage, label: factory:a, next: build }\n  build: { uses: build, label: factory:b }\n"
	if _, err := ParseYAML("w", []byte(ok)); err != nil {
		t.Fatalf("baseline: %v", err)
	}
	cases := map[string]string{
		"unknown key":      "steps:\n  triage: { uses: triage, bogus: 1 }\n",
		"unknown type":     "steps:\n  triage: { uses: wizard }\n",
		"duplicate label":  "steps:\n  a: { uses: triage, label: factory:x, next: b }\n  b: { uses: build, label: factory:x }\n",
		"missing target":   "steps:\n  a: { uses: triage, next: nowhere }\n",
		"next loop":        "steps:\n  a: { uses: triage, next: b }\n  b: { uses: build, next: a }\n",
		"unreachable":      "steps:\n  a: { uses: triage }\n  b: { uses: build }\n",
		"edge after plain": "steps:\n  a: { uses: triage, next: [{ to: b }, { to: c, if: x }] }\n  b: { uses: build }\n  c: { uses: pr }\n",
		"verify no reject": "steps:\n  a: { uses: verify }\n",
		"check no run":     "steps:\n  a: { uses: check }\n",
		"run on agent":     "steps:\n  a: { uses: build, run: make }\n",
		"bad park":         "steps:\n  a: { uses: plan, next: [{ park: later }] }\n",
		"not a map":        "- a\n- b\n",
		"no steps":         "name: w\n",
		"bad yaml":         "steps: [",
	}
	for name, in := range cases {
		if _, err := ParseYAML("w", []byte(in)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	mdBad := map[string]string{
		"two starts":      "---\nstages:\n  a: {uses: triage}\n  b: {uses: build}\n---\n",
		"no start":        "---\nstages:\n  a: {uses: triage, needs: b}\n  b: {uses: build, needs: a}\n---\n",
		"bad approval":    "---\nstages:\n  triage: {}\n  plan: {needs: triage, approval: sometimes}\n---\n",
		"unclosed front":  "---\nstages:\n  triage: {}\n",
		"front not a map": "---\n- a\n---\nbody",
		"verify at root":  "---\nstages:\n  verify: {}\n---\n",
		"needs a map":     "---\nstages:\n  triage: {}\n  build: {needs: {a: b}}\n---\n",
	}
	for name, in := range mdBad {
		if _, err := ParseMarkdown("w", []byte(in)); err == nil {
			t.Errorf("md %s: accepted", name)
		}
	}
	if _, err := Load("nope.yml"); err == nil || !strings.Contains(err.Error(), "missing_workflow_file") {
		t.Errorf("missing file: %v", err)
	}
	if _, err := Load("load.go"); err == nil {
		t.Error("a .go file loaded")
	}
}

func TestFreshSessionIsForcedOnVerify(t *testing.T) {
	// Spec 5 of the ticket: whatever the workflow says, verify runs in a fresh session.
	cases := map[string]string{
		"verify says false":  "steps:\n  a: { uses: triage, next: v }\n  v: { uses: verify, fresh_session: false, reject: a }\n",
		"marked verify":      "steps:\n  a: { uses: triage, next: v }\n  v: { uses: agent, verify: true, fresh_session: false, reject: a }\n",
		"verify no override": "steps:\n  a: { uses: triage, next: v }\n  v: { uses: verify, reject: a }\n",
	}
	for name, in := range cases {
		g, err := ParseYAML("w", []byte(in))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if n, _ := g.Node("v"); !n.FreshSession || !n.Verify {
			t.Errorf("%s: %+v", name, n)
		}
	}
	g, err := ParseYAML("w", []byte("steps:\n  a: { uses: triage, fresh_session: true, next: b }\n  b: { uses: build }\n"))
	if err != nil {
		t.Fatal(err)
	}
	a, _ := g.Node("a")
	b, _ := g.Node("b")
	if !a.FreshSession || b.FreshSession {
		t.Errorf("fresh_session on a non-verify node: a=%v b=%v", a.FreshSession, b.FreshSession)
	}
}

func TestNext(t *testing.T) {
	g, err := Load(filepath.Join(workflowsDir, "security-audit.yml"))
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		node    string
		out     Outcome
		want    string
		wantErr error
	}{
		{"triage", Pass, "plan", nil},
		{"plan", Pass, "plan.approval", nil},
		{"plan.approval", Pass, "build", nil},
		{"plan.approval", Revise, "plan", nil},
		{"verify", Pass, "pr", nil},
		{"verify", Fail, "build", nil},
		{"pr", Revise, "build", nil},
		{"pr", Pass, End, nil},
		{"build", Fail, "", ErrNoEdge},
		{"triage", Revise, "", ErrNoEdge},
	}
	for _, c := range cases {
		got, err := g.Next(c.node, c.out)
		if got != c.want || !errors.Is(err, c.wantErr) {
			t.Errorf("Next(%s,%s) = %q, %v; want %q, %v", c.node, c.out, got, err, c.want, c.wantErr)
		}
	}
	if _, err := g.Next("ghost", Pass); err == nil {
		t.Error("unknown node accepted")
	}
	if _, err := g.Next("triage", Outcome("maybe")); err == nil {
		t.Error("unknown outcome accepted")
	}
}

func TestNextWhereConditionalEdges(t *testing.T) {
	g, err := ParseYAML("w", []byte(`steps:
  plan: { uses: plan, next: [{ to: build, if: "plan.risk == 'low'" }, { park: awaiting-approval, approve: build, revise: plan }] }
  build: { uses: build }
`))
	if err != nil {
		t.Fatal(err)
	}
	low := func(c string) (bool, error) { return true, nil }
	high := func(c string) (bool, error) { return false, nil }
	boom := func(c string) (bool, error) { return false, errors.New("cannot resolve") }
	if got, _ := g.NextWhere("plan", Pass, low); got != "build" {
		t.Errorf("low: %q", got)
	}
	if got, _ := g.NextWhere("plan", Pass, high); got != "plan.approval" {
		t.Errorf("high: %q", got)
	}
	if got, _ := g.Next("plan", Pass); got != "plan.approval" {
		t.Errorf("nil eval: %q", got)
	}
	if _, err := g.NextWhere("plan", Pass, boom); err == nil {
		t.Error("evaluator error swallowed")
	}
}

func TestFanout(t *testing.T) {
	g, err := ParseYAML("w", []byte(`steps:
  split: { uses: fanout, next: [{ to: a }] }
  a: { uses: build }
`))
	if err != nil {
		t.Fatal(err)
	}
	if b, err := g.Branches("split"); err != nil || len(b) != 1 || b[0] != "a" {
		t.Errorf("%v %v", b, err)
	}
	if _, err := g.Branches("a"); err == nil {
		t.Error("Branches on an agent node")
	}
	if n, _ := g.Node("split"); n.Kind != KindFanout {
		t.Errorf("kind %s", n.Kind)
	}
}

func TestCheckAndHumanNodes(t *testing.T) {
	g, err := ParseYAML("w", []byte(`steps:
  build: { uses: build, next: lint }
  lint: { uses: check, run: make lint, runtime: local, next: ask }
  ask: { uses: human, next: done }
  done: { uses: pr }
`))
	if err != nil {
		t.Fatal(err)
	}
	lint, _ := g.Node("lint")
	ask, _ := g.Node("ask")
	if lint.Kind != KindCheck || lint.Run != "make lint" || lint.Runtime != "local" || ask.Kind != KindHuman {
		t.Errorf("%+v %+v", lint, ask)
	}
}

// Symphony spec section 5.2 and 5.4.
func TestSymphonyWorkflowMD(t *testing.T) {
	src := "---\ntracker:\n  kind: github\npolling:\n  interval_ms: 30000\nunknown_extension: 1\n---\n\nFix {{ issue.title }} (attempt {{ attempt }}).\n"
	g, err := ParseMarkdown("WORKFLOW", []byte(src))
	if err != nil {
		t.Fatal(err)
	}
	if g.Prompt != "Fix {{ issue.title }} (attempt {{ attempt }})." {
		t.Errorf("prompt %q", g.Prompt)
	}
	if g.Config["unknown_extension"] != 1 || g.Config["tracker"].(map[string]any)["kind"] != "github" {
		t.Errorf("config %v", g.Config)
	}
	if g.Start != "run" || len(g.Nodes()) != 1 {
		t.Errorf("graph %s", g.Describe())
	}
	out, err := g.RenderPrompt("run", map[string]any{"issue": map[string]any{"title": "crash"}, "attempt": nil})
	if err != nil || out != "Fix crash (attempt )." {
		t.Errorf("%q %v", out, err)
	}
	// 5.2: no front matter means an empty config and the whole file is the prompt.
	g, err = ParseMarkdown("WORKFLOW", []byte("  just a prompt \n"))
	if err != nil || g.Prompt != "just a prompt" || len(g.Config) != 0 {
		t.Errorf("%+v %v", g, err)
	}
	// 5.5: a front matter that is not a map, and an unknown variable in the body.
	if _, err := ParseMarkdown("w", []byte("---\n- a\n---\nx")); err == nil || !strings.Contains(err.Error(), "workflow_front_matter_not_a_map") {
		t.Errorf("not a map: %v", err)
	}
	if _, err := ParseMarkdown("w", []byte("---\ntracker: {}\n---\nHi {{ isue.title }}")); err == nil || !strings.Contains(err.Error(), "isue.title") {
		t.Errorf("unknown var at load: %v", err)
	}
}

func TestStagesWithBodyAndFreshVerify(t *testing.T) {
	g, err := Load(filepath.Join(workflowsDir, "ci-fix.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(g.Prompt, "Fix the failing CI run") {
		t.Errorf("prompt %q", g.Prompt)
	}
	if next, _ := g.Next("verify", Fail); next != "build" {
		t.Errorf("verify fail goes to %q", next)
	}
	if b, _ := g.Node("build"); strings.Join(b.Gates, ",") != "lint,unit" {
		t.Errorf("gates %v", b.Gates)
	}
}
