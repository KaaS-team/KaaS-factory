package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// WriteKind is a write the harness may do for an agent that has no write access of its own.
type WriteKind string

// The safe output kinds.
const (
	WriteComment WriteKind = "comment" // post a comment on the ticket
	WriteLabel   WriteKind = "label"   // change a factory label on the ticket
	WritePR      WriteKind = "pr"      // open a pull request
)

// TriggerKind is what starts a workflow.
type TriggerKind string

// The trigger kinds. The zero Trigger is manual.
const (
	OnManual   TriggerKind = "manual"
	OnLabel    TriggerKind = "label"
	OnSchedule TriggerKind = "schedule"
)

// Trigger says what starts a workflow: an issue label, a cron schedule, or a person.
type Trigger struct {
	Kind  TriggerKind
	Value string // the label, or the five-field cron expression; empty for manual
}

const (
	// DefaultWorkflowName is the file name of the repo's default workflow (Symphony spec 5.1).
	DefaultWorkflowName = "WORKFLOW.md"
	// DefaultWorkflow is the name of the workflow a ticket runs when it names none.
	DefaultWorkflow = "issue-to-pr"
	// workflowDir holds the repo's workflow files; a file there named like the default replaces it.
	workflowDir = ".factory/workflows"
)

// defaultSteps is the built-in default workflow: build, then a verify in a fresh session; a rejected
// verify goes back to build.
const defaultSteps = `steps:
  build:
    uses: build
    label: factory:building
    next: verify
  verify:
    uses: verify
    label: factory:verifying
    reject: build
`

// markdownVars are the template variables a markdown workflow body may use.
var markdownVars = map[string]bool{"ticket.title": true, "ticket.body": true, "attempt": true}

var markdownKeys = map[string]bool{
	"name": true, "on": true, "agent": true, "model_tier": true, "budget": true, "nodes": true, "safe_outputs": true,
}

var tmplVar = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

// LoadMarkdown reads a workflow written as one markdown file: YAML front matter for the graph and
// the body as the default prompt. Without a nodes key the file is one agent node that runs the body.
func LoadMarkdown(path string) (*Graph, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("missing_workflow_file: %w", err)
	}
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	front, body, bodyLine, err := splitFrontMatter(string(data))
	if err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if err := checkMarkdownVars(body, bodyLine); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	if _, err := parseTemplate(body); err != nil { // syntax and filters; the variables passed above
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(front), &root); err != nil {
		return nil, fmt.Errorf("workflow_parse_error: %w", err)
	}
	var m *yaml.Node
	if len(root.Content) > 0 {
		if root.Content[0].Kind != yaml.MappingNode {
			return nil, fmt.Errorf("workflow_front_matter_not_a_map: %s", name)
		}
		m = root.Content[0]
	}
	body = strings.TrimSpace(body)
	var g *Graph
	if m != nil && child(m, "nodes") != nil {
		if g, err = build(name, m, "nodes", body, 1, checkNodePrompt); err != nil {
			return nil, err
		}
	} else {
		g = &Graph{Name: name, Start: "run", Prompt: body, nodes: []Node{{ID: "run", Kind: KindAgent, Uses: "agent"}}}
		if m != nil {
			var top struct {
				Name string `yaml:"name"`
			}
			if err := m.Decode(&top); err == nil && top.Name != "" {
				g.Name = top.Name
			}
		}
	}
	if m != nil {
		if err := g.applyFrontMatter(m); err != nil {
			return nil, fmt.Errorf("%s: %w", g.Name, err)
		}
	}
	return g, nil
}

// LoadDefault loads the repo's default workflow: WORKFLOW.md at root when it exists, else
// .factory/workflows/issue-to-pr.yml, .yaml or .md, else the built-in issue-to-pr. A file that fails to
// load is an error; it never falls back (Symphony spec 5.4).
func LoadDefault(root string) (*Graph, error) {
	if p := filepath.Join(root, DefaultWorkflowName); fileExists(p) {
		return loadNamed(p, LoadMarkdown)
	}
	if p := WorkflowFile(root, DefaultWorkflow); p != "" {
		return loadNamed(p, Load)
	}
	return ParseYAML(DefaultWorkflow, []byte(defaultSteps))
}

// loadNamed loads p and prefixes a failure with the file, so the error says where to look.
func loadNamed(p string, load func(string) (*Graph, error)) (*Graph, error) {
	g, err := load(p)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", p, err)
	}
	return g, nil
}

// WorkflowFile returns the path of the repo's workflow file called name, or "" when there is none.
func WorkflowFile(root, name string) string {
	for _, ext := range []string{".yml", ".yaml", ".md"} {
		if p := filepath.Join(root, workflowDir, name+ext); fileExists(p) {
			return p
		}
	}
	return ""
}

func fileExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// splitFrontMatter returns the front matter text, the body, and the 1-based file line the body starts on.
func splitFrontMatter(src string) (front, body string, bodyLine int, err error) {
	lines := strings.Split(strings.ReplaceAll(src, "\r\n", "\n"), "\n")
	if strings.TrimRight(lines[0], " \t") != "---" {
		return "", strings.Join(lines, "\n"), 1, nil
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimRight(lines[i], " \t") == "---" {
			return strings.Join(lines[1:i], "\n"), strings.Join(lines[i+1:], "\n"), i + 2, nil
		}
	}
	return "", "", 0, fmt.Errorf("workflow_parse_error: front matter is not closed")
}

// checkMarkdownVars fails on the first variable a markdown workflow does not provide, naming it and
// its file line. line is the file line of the first line of text, or 0 to leave the line out.
func checkMarkdownVars(text string, line int) error {
	for i, l := range strings.Split(text, "\n") {
		for _, m := range tmplVar.FindAllStringSubmatch(l, -1) {
			v := strings.TrimSpace(strings.SplitN(m[1], "|", 2)[0])
			if markdownVars[v] || v == "" {
				continue
			}
			if line == 0 {
				return fmt.Errorf("template_render_error: unknown variable %q", v)
			}
			return fmt.Errorf("template_render_error: line %d: unknown variable %q", line+i, v)
		}
	}
	return nil
}

func checkNodePrompt(p string, line int) error {
	if err := checkMarkdownVars(p, line); err != nil {
		return err
	}
	_, err := parseTemplate(p)
	return err
}

func (g *Graph) applyFrontMatter(m *yaml.Node) error {
	for i := 0; i+1 < len(m.Content); i += 2 {
		k, v := m.Content[i].Value, m.Content[i+1]
		if !markdownKeys[k] {
			return fmt.Errorf("unknown key %q", k)
		}
		var err error
		switch k {
		case "on":
			g.On, err = parseTrigger(v)
		case "agent":
			g.Agent, err = text(k, v)
		case "model_tier":
			g.ModelTier, err = text(k, v)
		case "budget":
			if err = v.Decode(&g.Budget); err != nil || g.Budget <= 0 {
				err = fmt.Errorf("budget must be a number above zero")
			}
		case "safe_outputs":
			g.SafeOutputs, err = parseSafeOutputs(v)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func text(key string, v *yaml.Node) (string, error) {
	if v.Kind != yaml.ScalarNode || strings.TrimSpace(v.Value) == "" {
		return "", fmt.Errorf("%s must be a non-empty string", key)
	}
	return v.Value, nil
}

func parseTrigger(v *yaml.Node) (Trigger, error) {
	if v.Kind == yaml.ScalarNode {
		if v.Value != "manual" {
			return Trigger{}, fmt.Errorf("on %q: a bare value must be manual; use label or schedule as a key", v.Value)
		}
		return Trigger{Kind: OnManual}, nil
	}
	if v.Kind != yaml.MappingNode || len(v.Content) != 2 {
		return Trigger{}, fmt.Errorf("on must be manual or have exactly one of label, schedule")
	}
	key, val := v.Content[0].Value, v.Content[1]
	switch key {
	case "label":
		s, err := text("on.label", val)
		return Trigger{Kind: OnLabel, Value: s}, err
	case "schedule":
		s, err := text("on.schedule", val)
		if err == nil && len(strings.Fields(s)) != 5 {
			err = fmt.Errorf("on.schedule %q needs 5 fields", s)
		}
		return Trigger{Kind: OnSchedule, Value: s}, err
	case "manual":
		return Trigger{Kind: OnManual}, nil
	}
	return Trigger{}, fmt.Errorf("on: unknown trigger %q", key)
}

func parseSafeOutputs(v *yaml.Node) ([]WriteKind, error) {
	if v.Kind != yaml.SequenceNode {
		return nil, fmt.Errorf("safe_outputs must be a list of write kinds")
	}
	var out []WriteKind
	for _, c := range v.Content {
		k := WriteKind(c.Value)
		switch k {
		case WriteComment, WriteLabel, WritePR:
		default:
			return nil, fmt.Errorf("safe_outputs: unknown write kind %q (want comment, label or pr)", c.Value)
		}
		for _, have := range out {
			if have == k {
				return nil, fmt.Errorf("safe_outputs: duplicate write kind %q", k)
			}
		}
		out = append(out, k)
	}
	return out, nil
}
