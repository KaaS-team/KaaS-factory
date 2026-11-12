// Package graph runs a pipeline as nodes and edges. It loads the factory's .factory/workflows files
// (yml steps, md stages) and a Symphony-style WORKFLOW.md (spec section 5) into one Graph.
package graph

import (
	"errors"
	"fmt"
)

// NodeKind is what a node does.
type NodeKind string

// The node kinds.
const (
	KindAgent  NodeKind = "agent"  // a stage run by a coding agent
	KindCheck  NodeKind = "check"  // a shell command, exit 0 passes
	KindHuman  NodeKind = "human"  // parks until a person approves or asks for a revision
	KindFanout NodeKind = "fanout" // starts every outgoing pass edge in parallel
)

// Outcome labels an edge.
type Outcome string

// The edge outcomes.
const (
	Pass   Outcome = "pass"
	Fail   Outcome = "fail"
	Revise Outcome = "revise"
)

// End is what Next returns when a terminal node passes: the workflow is over.
const End = ""

// ErrNoEdge means a node has no edge for the outcome.
var ErrNoEdge = errors.New("no edge for outcome")

// Node is one step of a workflow.
type Node struct {
	ID    string
	Kind  NodeKind
	Uses  string // the step type, such as build or verify; empty for a human or fanout node
	Label string // the factory:* label held while the node runs
	Run   string // a check node's shell command
	// Runtime names where a check node's command runs.
	Runtime string
	Gates   []string
	MCP     []string
	// Approval is a human node's policy: "always" or "on-risk:<level>"; empty when the edge itself parks.
	Approval string
	// After is a human node's auto-approve window such as 4h; empty waits for a person.
	After  string
	Prompt string
	// Verify marks a verification node.
	Verify bool
	// FreshSession is true for every verify node, whatever the workflow file says.
	FreshSession bool
	// Tier is the agent size for this node, "small" or "large"; empty leaves it to the runner.
	Tier string
	// Budget is the node's token budget; zero means none set.
	Budget int
	// Skills names the skills the node's agent loads.
	Skills []string
}

// Edge leads from one node to another when From ends with outcome On. If is an optional condition
// the runner evaluates; an edge with no If is the default.
type Edge struct {
	From, To string
	On       Outcome
	If       string
}

// Graph is a loaded workflow.
type Graph struct {
	Name  string
	Start string
	// Prompt is the workflow's prompt template (the markdown body), rendered with RenderPrompt.
	Prompt string
	// Config holds the front matter of a Symphony-style WORKFLOW.md, unchanged.
	Config map[string]any
	// On, Agent, ModelTier, Budget and SafeOutputs come from the front matter of a markdown workflow
	// loaded with LoadMarkdown. Budget is in dollars. SafeOutputs is empty when the file lists none.
	On          Trigger
	Agent       string
	ModelTier   string
	Budget      float64
	SafeOutputs []WriteKind
	// Warnings lists deprecated forms the file used, such as the top-level agents map. Load does not print them.
	Warnings []string
	nodes    []Node
	edges    []Edge
}

// Nodes returns the nodes in file order.
func (g *Graph) Nodes() []Node { return append([]Node(nil), g.nodes...) }

// Edges returns the edges in file order.
func (g *Graph) Edges() []Edge { return append([]Edge(nil), g.edges...) }

// Node returns the node with the given id.
func (g *Graph) Node(id string) (Node, bool) {
	for _, n := range g.nodes {
		if n.ID == id {
			return n, true
		}
	}
	return Node{}, false
}

// Next returns the node that follows node when it ends with outcome, taking the default (unconditional)
// edge. A terminal node that passes returns End. Any other missing edge is ErrNoEdge.
func (g *Graph) Next(node string, outcome Outcome) (string, error) {
	return g.NextWhere(node, outcome, nil)
}

// NextWhere is Next with a condition evaluator: the first edge whose If holds wins, and an edge with
// no If always holds. A nil eval treats every conditional edge as false.
func (g *Graph) NextWhere(node string, outcome Outcome, eval func(cond string) (bool, error)) (string, error) {
	n, ok := g.Node(node)
	if !ok {
		return "", fmt.Errorf("graph %s: no node %q", g.Name, node)
	}
	if outcome != Pass && outcome != Fail && outcome != Revise {
		return "", fmt.Errorf("graph %s: unknown outcome %q", g.Name, outcome)
	}
	seen := false
	for _, e := range g.edges {
		if e.From != node || e.On != outcome {
			continue
		}
		seen = true
		if e.If == "" {
			return e.To, nil
		}
		if eval == nil {
			continue
		}
		ok, err := eval(e.If)
		if err != nil {
			return "", fmt.Errorf("graph %s: edge %s to %s: %w", g.Name, node, e.To, err)
		}
		if ok {
			return e.To, nil
		}
	}
	if !seen && outcome == Pass && n.Kind != KindFanout && g.terminal(node) {
		return End, nil
	}
	return "", fmt.Errorf("graph %s: node %s, outcome %s: %w", g.Name, node, outcome, ErrNoEdge)
}

// Branches returns the targets of a fanout node's pass edges, all of which run.
func (g *Graph) Branches(node string) ([]string, error) {
	n, ok := g.Node(node)
	if !ok || n.Kind != KindFanout {
		return nil, fmt.Errorf("graph %s: %q is not a fanout node", g.Name, node)
	}
	var out []string
	for _, e := range g.edges {
		if e.From == node && e.On == Pass {
			out = append(out, e.To)
		}
	}
	return out, nil
}

// terminal reports whether node has no pass edge out.
func (g *Graph) terminal(node string) bool {
	for _, e := range g.edges {
		if e.From == node && e.On == Pass {
			return false
		}
	}
	return true
}

// Describe lists nodes then edges, one per line, in a stable text form.
func (g *Graph) Describe() string {
	s := "name " + g.Name + "\nstart " + g.Start + "\n"
	for _, n := range g.nodes {
		s += fmt.Sprintf("node %s kind=%s uses=%s label=%s fresh=%t", n.ID, n.Kind, n.Uses, n.Label, n.FreshSession)
		if n.Approval != "" {
			s += " approval=" + n.Approval
		}
		if n.After != "" {
			s += " after=" + n.After
		}
		s += "\n"
	}
	for _, e := range g.edges {
		s += fmt.Sprintf("edge %s -%s-> %s", e.From, e.On, e.To)
		if e.If != "" {
			s += " if " + e.If
		}
		s += "\n"
	}
	return s
}
