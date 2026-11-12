package graph

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func writeFile(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

const equalSteps = `  triage: { uses: triage, label: "factory:triage", next: build }
  build: { uses: build, label: "factory:build", next: verify }
  verify: { uses: verify, label: "factory:verify", reject: build, next: pr }
  pr: { uses: pr, label: "factory:pr" }
`

// Ticket acceptance 1: a markdown workflow and the equivalent YAML workflow load to equal graphs.
func TestLoadMarkdownEqualsYAML(t *testing.T) {
	dir := t.TempDir()
	md := writeFile(t, dir, "flow.md", "---\nname: flow\nnodes:\n"+equalSteps+"---\n")
	yml := writeFile(t, dir, "flow.yml", "name: flow\nsteps:\n"+equalSteps)
	a, err := LoadMarkdown(md)
	if err != nil {
		t.Fatal(err)
	}
	b, err := Load(yml)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(a, b) {
		t.Errorf("graphs differ:\n--- md\n%s--- yaml\n%s", describe(a), describe(b))
	}
	// The body is the default prompt of every node without its own.
	body := writeFile(t, dir, "body.md", "---\nname: flow\nnodes:\n"+equalSteps+"---\nWork on {{ticket.title}}.\n")
	g, err := LoadMarkdown(body)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(g.Nodes(), b.Nodes()) || !reflect.DeepEqual(g.edges, b.edges) || g.Start != b.Start {
		t.Errorf("body changed the graph:\n%s", describe(g))
	}
	out, err := g.RenderPrompt("build", map[string]any{"ticket": map[string]any{"title": "crash"}})
	if err != nil || out != "Work on crash." {
		t.Errorf("%q %v", out, err)
	}
}

// Without nodes the file is one agent node that runs the body, as in Symphony spec 5.2.
func TestLoadMarkdownWithoutNodes(t *testing.T) {
	p := writeFile(t, t.TempDir(), "solo.md", "---\non: manual\nagent: claude\n---\nDo it.\n")
	g, err := LoadMarkdown(p)
	if err != nil {
		t.Fatal(err)
	}
	if g.Name != "solo" || g.Start != "run" || len(g.Nodes()) != 1 || g.Prompt != "Do it." || g.Agent != "claude" {
		t.Errorf("%+v", g)
	}
}

// Ticket acceptance 2: an unknown template variable fails naming the variable and its line.
func TestLoadMarkdownTemplateVariables(t *testing.T) {
	cases := []struct {
		name, src, errHas string
	}{
		{"known", "---\non: manual\n---\n{{ticket.title}} {{ ticket.body | upcase }} {{attempt}}\n", ""},
		{"unknown root on line 5", "---\non: manual\n---\nFirst.\nSee {{ticket.titel}} now.\n", "line 5: unknown variable \"ticket.titel\""},
		{"unknown root", "---\non: manual\n---\n{{issue.title}}\n", "line 4: unknown variable \"issue.title\""},
		{"no front matter", "ok\n\n{{foo}}\n", "line 3: unknown variable \"foo\""},
		{"second on a line", "---\non: manual\n---\n{{attempt}} {{nope}}\n", "line 4: unknown variable \"nope\""},
		{"unknown filter", "---\non: manual\n---\n{{attempt | shout}}\n", "shout"},
		{"unclosed", "---\non: manual\n---\n{{attempt\n", "template_parse_error"},
	}
	for _, c := range cases {
		_, err := LoadMarkdown(writeFile(t, t.TempDir(), "w.md", c.src))
		switch {
		case c.errHas == "" && err != nil:
			t.Errorf("%s: %v", c.name, err)
		case c.errHas != "" && (err == nil || !strings.Contains(err.Error(), c.errHas)):
			t.Errorf("%s: got %v, want %q", c.name, err, c.errHas)
		}
	}
}

// Ticket acceptance 3: a missing safe_outputs is an empty write list; an unknown kind fails.
func TestLoadMarkdownSafeOutputs(t *testing.T) {
	cases := []struct {
		name, fm string
		want     []WriteKind
		errHas   string
	}{
		{"absent", "on: manual", nil, ""},
		{"empty list", "on: manual\nsafe_outputs: []", nil, ""},
		{"all", "on: manual\nsafe_outputs: [comment, label, pr]", []WriteKind{WriteComment, WriteLabel, WritePR}, ""},
		{"unknown", "on: manual\nsafe_outputs: [comment, merge]", nil, "safe_outputs: unknown write kind \"merge\""},
		{"duplicate", "on: manual\nsafe_outputs: [pr, pr]", nil, "duplicate"},
		{"not a list", "on: manual\nsafe_outputs: comment", nil, "safe_outputs"},
	}
	for _, c := range cases {
		g, err := LoadMarkdown(writeFile(t, t.TempDir(), "w.md", "---\n"+c.fm+"\n---\nbody\n"))
		if c.errHas != "" {
			if err == nil || !strings.Contains(err.Error(), c.errHas) {
				t.Errorf("%s: got %v, want %q", c.name, err, c.errHas)
			}
			continue
		}
		if err != nil {
			t.Errorf("%s: %v", c.name, err)
			continue
		}
		if len(g.SafeOutputs) != len(c.want) || (len(c.want) > 0 && !reflect.DeepEqual(g.SafeOutputs, c.want)) {
			t.Errorf("%s: %v want %v", c.name, g.SafeOutputs, c.want)
		}
	}
}

func TestLoadMarkdownFrontMatterKeys(t *testing.T) {
	cases := []struct {
		name, fm string
		check    func(*Graph) bool
		errHas   string
	}{
		{"label", "on: { label: \"factory:ready\" }", func(g *Graph) bool { return g.On == Trigger{Kind: OnLabel, Value: "factory:ready"} }, ""},
		{"schedule", "on: { schedule: \"0 6 * * 1\" }", func(g *Graph) bool { return g.On == Trigger{Kind: OnSchedule, Value: "0 6 * * 1"} }, ""},
		{"manual scalar", "on: manual", func(g *Graph) bool { return g.On == Trigger{Kind: OnManual} }, ""},
		{"tier and budget", "on: manual\nmodel_tier: standard\nbudget: 2.5", func(g *Graph) bool { return g.ModelTier == "standard" && g.Budget == 2.5 }, ""},
		{"no on is manual", "agent: claude", func(g *Graph) bool { return g.On.Kind == "" }, ""},
		{"two triggers", "on: { label: a, schedule: \"* * * * *\" }", nil, "exactly one"},
		{"unknown trigger", "on: { webhook: a }", nil, "unknown trigger"},
		{"empty label", "on: { label: \"\" }", nil, "label"},
		{"bad schedule", "on: { schedule: soon }", nil, "5 fields"},
		{"bad scalar", "on: sometimes", nil, "manual"},
		{"negative budget", "on: manual\nbudget: -1", nil, "budget"},
		{"budget text", "on: manual\nbudget: lots", nil, "budget"},
		{"unknown key", "on: manual\ntracker: {}", nil, "unknown key \"tracker\""},
		{"bad node", "on: manual\nnodes:\n  a: { uses: wizard }", nil, "unknown step type"},
		{"agent not text", "on: manual\nagent: [a]", nil, "agent"},
		{"front not a map", "- a", nil, "workflow_front_matter_not_a_map"},
	}
	for _, c := range cases {
		g, err := LoadMarkdown(writeFile(t, t.TempDir(), "w.md", "---\n"+c.fm+"\n---\nbody\n"))
		if c.errHas != "" {
			if err == nil || !strings.Contains(err.Error(), c.errHas) {
				t.Errorf("%s: got %v, want %q", c.name, err, c.errHas)
			}
			continue
		}
		if err != nil || !c.check(g) {
			t.Errorf("%s: %v %+v", c.name, err, g)
		}
	}
	if _, err := LoadMarkdown("nope.md"); err == nil || !strings.Contains(err.Error(), "missing_workflow_file") {
		t.Errorf("missing: %v", err)
	}
	if _, err := LoadMarkdown(writeFile(t, t.TempDir(), "w.md", "---\non: manual\n")); err == nil || !strings.Contains(err.Error(), "not closed") {
		t.Errorf("unclosed: %v", err)
	}
}

// Ticket acceptance 4 and Symphony spec 5.1: a root WORKFLOW.md is the default workflow.
func TestLoadDefault(t *testing.T) {
	const fallback = "steps:\n  triage: { uses: triage }\n"
	cases := []struct {
		name  string
		files map[string]string
		want  string // the graph name, or "" for an error
	}{
		{"root WORKFLOW.md wins", map[string]string{"WORKFLOW.md": "---\nname: mine\non: manual\n---\nGo.\n", workflowDir + "/issue-to-pr.yml": fallback}, "mine"},
		{"WORKFLOW.md without front matter", map[string]string{"WORKFLOW.md": "Just a prompt.\n"}, "WORKFLOW"},
		{"repo issue-to-pr file replaces the built-in", map[string]string{workflowDir + "/issue-to-pr.yml": fallback}, "issue-to-pr"},
		{"nothing at all is the built-in", map[string]string{}, "issue-to-pr"},
		{"broken repo file does not fall back", map[string]string{workflowDir + "/issue-to-pr.yml": "steps: 3\n"}, ""},
		{"broken WORKFLOW.md does not fall back", map[string]string{"WORKFLOW.md": "---\non: sometimes\n---\n", workflowDir + "/issue-to-pr.yml": fallback}, ""},
	}
	for _, c := range cases {
		root := t.TempDir()
		for name, body := range c.files {
			writeFile(t, root, name, body)
		}
		g, err := LoadDefault(root)
		if c.want == "" {
			if err == nil {
				t.Errorf("%s: loaded %s", c.name, g.Name)
			}
			continue
		}
		if err != nil || g.Name != c.want {
			t.Errorf("%s: %v %+v", c.name, err, g)
			continue
		}
		if c.name == "repo issue-to-pr file replaces the built-in" && len(g.Nodes()) != 1 {
			t.Errorf("%s: loaded %d nodes, want the repo file's one", c.name, len(g.Nodes()))
		}
		if c.name == "nothing at all is the built-in" {
			if next, err := g.Next("verify", Fail); err != nil || next != "build" {
				t.Errorf("%s: verify fail goes to %q, %v", c.name, next, err)
			}
		}
	}
}
