package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

var stepTypes = map[string]NodeKind{
	"triage": KindAgent, "plan": KindAgent, "build": KindAgent, "verify": KindAgent, "pr": KindAgent,
	"import-plan": KindAgent, "report": KindAgent, "agent": KindAgent,
	"check": KindCheck, "human": KindHuman, "fanout": KindFanout,
}

var stepKeys = map[string]bool{
	"uses": true, "label": true, "next": true, "reject": true, "revise": true, "run": true, "runtime": true,
	"mcp": true, "needs": true, "approval": true, "gates": true, "after": true, "fresh_session": true,
	"verify": true, "prompt": true,
}

type step struct {
	Uses         string    `yaml:"uses"`
	Label        string    `yaml:"label"`
	Next         yaml.Node `yaml:"next"`
	Reject       string    `yaml:"reject"`
	Revise       string    `yaml:"revise"`
	Run          string    `yaml:"run"`
	Runtime      string    `yaml:"runtime"`
	MCP          []string  `yaml:"mcp"`
	Needs        yaml.Node `yaml:"needs"`
	Approval     string    `yaml:"approval"`
	Gates        []string  `yaml:"gates"`
	After        string    `yaml:"after"`
	FreshSession *bool     `yaml:"fresh_session"`
	Verify       *bool     `yaml:"verify"`
	Prompt       string    `yaml:"prompt"`
}

// Load reads a workflow file: .yml or .yaml is the steps format, .md is stages or a Symphony WORKFLOW.md.
func Load(path string) (*Graph, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("missing_workflow_file: %w", err)
	}
	name := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	switch filepath.Ext(path) {
	case ".yml", ".yaml":
		return ParseYAML(name, data)
	case ".md":
		return ParseMarkdown(name, data)
	}
	return nil, fmt.Errorf("%s: want .yml, .yaml or .md", path)
}

// LoadDir loads every workflow file in dir, keyed by workflow name.
func LoadDir(dir string) (map[string]*Graph, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*"))
	if err != nil {
		return nil, err
	}
	out := map[string]*Graph{}
	for _, f := range files {
		switch filepath.Ext(f) {
		case ".yml", ".yaml", ".md":
		default:
			continue
		}
		g, err := Load(f)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", filepath.Base(f), err)
		}
		out[g.Name] = g
	}
	return out, nil
}

// ParseYAML parses the steps format of docs/workflows.md.
func ParseYAML(name string, data []byte) (*Graph, error) {
	var root yaml.Node
	if err := yaml.Unmarshal(data, &root); err != nil {
		return nil, fmt.Errorf("workflow_parse_error: %w", err)
	}
	if len(root.Content) == 0 || root.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("workflow_front_matter_not_a_map: %s", name)
	}
	return build(name, root.Content[0], "steps", "", ValidateTemplate)
}

// ParseMarkdown parses a .md workflow. Front matter with a stages key is the factory stages format;
// any other front matter is a Symphony WORKFLOW.md (spec 5.2), a single agent node running the body.
func ParseMarkdown(name string, data []byte) (*Graph, error) {
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	var front, body string
	if rest, ok := strings.CutPrefix(text, "---\n"); ok {
		switch {
		case strings.HasPrefix(rest, "---\n") || rest == "---":
			body = strings.TrimPrefix(rest, "---")
		case strings.Contains("\n"+rest, "\n---\n") || strings.HasSuffix(rest, "\n---"):
			rest += "\n"
			end := strings.Index(rest, "\n---\n")
			front, body = rest[:end], rest[end+5:]
		default:
			return nil, fmt.Errorf("workflow_parse_error: front matter is not closed")
		}
	} else {
		body = text
	}
	body = strings.TrimSpace(body)
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(front), &root); err != nil {
		return nil, fmt.Errorf("workflow_parse_error: %w", err)
	}
	if len(root.Content) > 0 && root.Content[0].Kind != yaml.MappingNode {
		return nil, fmt.Errorf("workflow_front_matter_not_a_map: %s", name)
	}
	var m *yaml.Node
	if len(root.Content) > 0 {
		m = root.Content[0]
	}
	if m != nil && child(m, "stages") != nil {
		return build(name, m, "stages", body, ValidateTemplate)
	}
	return symphony(name, m, body)
}

func symphony(name string, m *yaml.Node, body string) (*Graph, error) {
	g := &Graph{Name: name, Start: "run", Prompt: body, Config: map[string]any{}}
	if m != nil {
		if err := m.Decode(&g.Config); err != nil {
			return nil, fmt.Errorf("workflow_parse_error: %w", err)
		}
		if s, ok := g.Config["name"].(string); ok && s != "" {
			g.Name = s
		}
	}
	if err := ValidateTemplate(body); err != nil {
		return nil, fmt.Errorf("%s: %w", name, err)
	}
	g.nodes = []Node{{ID: "run", Kind: KindAgent, Uses: "agent"}}
	return g, nil
}

func child(m *yaml.Node, key string) *yaml.Node {
	for i := 0; i+1 < len(m.Content); i += 2 {
		if m.Content[i].Value == key {
			return m.Content[i+1]
		}
	}
	return nil
}

type namedStep struct {
	id string
	step
}

// build turns the steps (key "steps" or "nodes") or stages of a mapping into a graph. check validates every
// node prompt template.
func build(name string, m *yaml.Node, key, body string, check func(string) error) (*Graph, error) {
	g := &Graph{Name: name, Prompt: body}
	var top struct {
		Name string `yaml:"name"`
	}
	if err := m.Decode(&top); err != nil {
		return nil, fmt.Errorf("workflow_parse_error: %w", err)
	}
	if top.Name != "" {
		g.Name = top.Name
	}
	sn := child(m, key)
	if sn == nil || sn.Kind != yaml.MappingNode || len(sn.Content) == 0 {
		return nil, fmt.Errorf("%s: %q must be a map with at least one step", g.Name, key)
	}
	var steps []namedStep
	ids := map[string]bool{}
	for i := 0; i+1 < len(sn.Content); i += 2 {
		id, node := sn.Content[i].Value, sn.Content[i+1]
		if ids[id] || id == "" {
			return nil, fmt.Errorf("%s: duplicate or empty step id %q", g.Name, id)
		}
		ids[id] = true
		if node.Kind != yaml.MappingNode {
			return nil, fmt.Errorf("%s: step %s must be a map", g.Name, id)
		}
		for j := 0; j+1 < len(node.Content); j += 2 {
			if k := node.Content[j].Value; !stepKeys[k] {
				return nil, fmt.Errorf("%s: step %s: unknown key %q", g.Name, id, k)
			}
		}
		var s step
		if err := node.Decode(&s); err != nil {
			return nil, fmt.Errorf("%s: step %s: %w", g.Name, id, err)
		}
		if s.Uses == "" {
			s.Uses = id
		}
		steps = append(steps, namedStep{id, s})
	}
	md := key == "stages"
	for _, s := range steps {
		if err := g.addStep(s, md, check); err != nil {
			return nil, fmt.Errorf("%s: %w", g.Name, err)
		}
	}
	if md {
		if err := g.linkNeeds(steps); err != nil {
			return nil, fmt.Errorf("%s: %w", g.Name, err)
		}
	} else {
		g.Start = steps[0].id
	}
	if err := g.validate(); err != nil {
		return nil, fmt.Errorf("%s: %w", g.Name, err)
	}
	return g, nil
}

func (g *Graph) addStep(s namedStep, md bool, check func(string) error) error {
	kind, ok := stepTypes[s.Uses]
	if !ok {
		return fmt.Errorf("step %s: unknown step type %q", s.id, s.Uses)
	}
	n := Node{ID: s.id, Kind: kind, Uses: s.Uses, Label: s.Label, Run: s.Run, Runtime: s.Runtime, Gates: s.Gates, MCP: s.MCP, Prompt: s.Prompt}
	if kind == KindHuman {
		n.Uses = ""
	}
	if kind == KindCheck && s.Run == "" {
		return fmt.Errorf("step %s: a check step needs run", s.id)
	}
	if kind != KindCheck && (s.Run != "" || s.Runtime != "") {
		return fmt.Errorf("step %s: run and runtime belong on a check step", s.id)
	}
	if s.Verify != nil {
		n.Verify = *s.Verify
	}
	n.Verify = n.Verify || s.Uses == "verify"
	n.FreshSession = n.Verify || (s.FreshSession != nil && *s.FreshSession)
	if n.Prompt != "" {
		if err := check(n.Prompt); err != nil {
			return fmt.Errorf("step %s: %w", s.id, err)
		}
	}
	g.nodes = append(g.nodes, n)
	if md {
		return nil
	}
	if s.Reject != "" {
		g.edges = append(g.edges, Edge{From: s.id, To: s.Reject, On: Fail})
	} else if n.Verify {
		return fmt.Errorf("step %s: a verify step needs reject", s.id)
	}
	if s.Revise != "" {
		g.edges = append(g.edges, Edge{From: s.id, To: s.Revise, On: Revise})
	}
	return g.nextEdges(s)
}

func (g *Graph) nextEdges(s namedStep) error {
	nx := s.Next
	switch nx.Kind {
	case 0:
		return nil
	case yaml.ScalarNode:
		g.edges = append(g.edges, Edge{From: s.id, To: nx.Value, On: Pass})
		return nil
	case yaml.SequenceNode:
	default:
		return fmt.Errorf("step %s: next must be a step id or a list of edges", s.id)
	}
	for i, item := range nx.Content {
		var e struct {
			To      string `yaml:"to"`
			If      string `yaml:"if"`
			Park    string `yaml:"park"`
			Approve string `yaml:"approve"`
			Revise  string `yaml:"revise"`
			After   string `yaml:"after"`
		}
		if item.Kind != yaml.MappingNode {
			return fmt.Errorf("step %s: edge %d must be a map", s.id, i)
		}
		for j := 0; j+1 < len(item.Content); j += 2 {
			switch item.Content[j].Value {
			case "to", "if", "park", "approve", "revise", "after":
			default:
				return fmt.Errorf("step %s: edge %d: unknown key %q", s.id, i, item.Content[j].Value)
			}
		}
		if err := item.Decode(&e); err != nil {
			return fmt.Errorf("step %s: edge %d: %w", s.id, i, err)
		}
		if e.Park == "" {
			if e.To == "" {
				return fmt.Errorf("step %s: edge %d needs to or park", s.id, i)
			}
			g.edges = append(g.edges, Edge{From: s.id, To: e.To, On: Pass, If: e.If})
			continue
		}
		if e.Park != "awaiting-approval" || e.Approve == "" || e.Revise == "" {
			return fmt.Errorf("step %s: edge %d: a park edge is park: awaiting-approval with approve and revise", s.id, i)
		}
		h := s.id + ".approval"
		g.nodes = append(g.nodes, Node{ID: h, Kind: KindHuman, Label: s.Label, After: e.After})
		g.edges = append(g.edges,
			Edge{From: s.id, To: h, On: Pass, If: e.If},
			Edge{From: h, To: e.Approve, On: Pass},
			Edge{From: h, To: e.Revise, On: Revise})
	}
	return nil
}

func (g *Graph) linkNeeds(steps []namedStep) error {
	approval := map[string]string{} // stage id -> human node id
	for _, s := range steps {
		if s.Approval == "" {
			continue
		}
		if s.Approval != "always" && !strings.HasPrefix(s.Approval, "on-risk:") {
			return fmt.Errorf("stage %s: approval %q is not always or on-risk:<level>", s.id, s.Approval)
		}
		h := s.id + ".approval"
		n, _ := g.Node(s.id)
		g.nodes = append(g.nodes, Node{ID: h, Kind: KindHuman, Label: n.Label, Approval: s.Approval, After: s.After})
		g.edges = append(g.edges, Edge{From: s.id, To: h, On: Pass}, Edge{From: h, To: s.id, On: Revise})
		approval[s.id] = h
	}
	for _, s := range steps {
		var needs []string
		switch s.Needs.Kind {
		case 0:
		case yaml.ScalarNode:
			needs = []string{s.Needs.Value}
		case yaml.SequenceNode:
			for _, c := range s.Needs.Content {
				needs = append(needs, c.Value)
			}
		default:
			return fmt.Errorf("stage %s: needs must be a stage id or a list", s.id)
		}
		if len(needs) == 0 {
			if g.Start != "" {
				return fmt.Errorf("stage %s: a second stage with no needs (start is %s)", s.id, g.Start)
			}
			g.Start = s.id
		}
		for _, need := range needs {
			from := need
			if h, ok := approval[need]; ok {
				from = h
			}
			g.edges = append(g.edges, Edge{From: from, To: s.id, On: Pass})
		}
		n, _ := g.Node(s.id)
		switch {
		case s.Reject != "":
			g.edges = append(g.edges, Edge{From: s.id, To: s.Reject, On: Fail})
		case n.Verify && len(needs) > 0:
			g.edges = append(g.edges, Edge{From: s.id, To: needs[0], On: Fail})
		case n.Verify:
			return fmt.Errorf("stage %s: a verify stage needs a stage to reject to", s.id)
		}
		if s.Revise != "" {
			g.edges = append(g.edges, Edge{From: s.id, To: s.Revise, On: Revise})
		}
	}
	if g.Start == "" {
		return fmt.Errorf("no stage without needs: the workflow has no start")
	}
	return nil
}

// validate applies what the loader refuses (docs/workflows.md): a duplicate label, an edge to a
// missing step, a pass loop, a step no edge reaches, and edges after one with no condition.
func (g *Graph) validate() error {
	labels := map[string]string{}
	nodeIDs := map[string]bool{}
	for _, n := range g.nodes {
		nodeIDs[n.ID] = true
		if n.Label != "" && n.Kind != KindHuman {
			if prev, dup := labels[n.Label]; dup {
				return fmt.Errorf("label %s is on both %s and %s", n.Label, prev, n.ID)
			}
			labels[n.Label] = n.ID
		}
	}
	for _, e := range g.edges {
		if !nodeIDs[e.From] || !nodeIDs[e.To] {
			return fmt.Errorf("edge %s -> %s: no such step", e.From, e.To)
		}
	}
	for _, n := range g.nodes {
		sawDefault := false
		for _, e := range g.edges {
			if e.From != n.ID || e.On != Pass || n.Kind == KindFanout {
				continue
			}
			if sawDefault {
				return fmt.Errorf("step %s: edges after one with no if", n.ID)
			}
			sawDefault = e.If == ""
		}
	}
	if err := g.noPassLoop(); err != nil {
		return err
	}
	reach := map[string]bool{g.Start: true}
	for changed := true; changed; {
		changed = false
		for _, e := range g.edges {
			if reach[e.From] && !reach[e.To] {
				reach[e.To], changed = true, true
			}
		}
	}
	for _, n := range g.nodes {
		if !reach[n.ID] {
			return fmt.Errorf("step %s is not reached by any edge", n.ID)
		}
	}
	return nil
}

func (g *Graph) noPassLoop() error {
	state := map[string]int{}
	var visit func(id string) error
	visit = func(id string) error {
		state[id] = 1
		for _, e := range g.edges {
			if e.From != id || e.On != Pass {
				continue
			}
			if state[e.To] == 1 {
				return fmt.Errorf("next loop through %s and %s (only reject, revise and approve may point back)", id, e.To)
			}
			if state[e.To] == 0 {
				if err := visit(e.To); err != nil {
					return err
				}
			}
		}
		state[id] = 2
		return nil
	}
	for _, n := range g.nodes {
		if state[n.ID] == 0 {
			if err := visit(n.ID); err != nil {
				return err
			}
		}
	}
	return nil
}
