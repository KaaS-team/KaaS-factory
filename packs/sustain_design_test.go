package packs_test

import (
	"regexp"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/graph"
)

// Cases cite Symphony section 5.4 (prompt templates: only issue, attempt, node, workflow).
var costWords = regexp.MustCompile(`(?i)\b(tokens?|costs?|spend|usd|model|budget)\b|\$`)

func TestNewPacksFreshSessionVerify(t *testing.T) {
	for _, name := range []string{"sustain-retest", "design-to-pr"} {
		g, _ := load(t, name)
		found := false
		for _, n := range g.Nodes() {
			if n.Verify {
				found = true
				if !n.FreshSession {
					t.Errorf("%s: verify node %s is not a fresh session", name, n.ID)
				}
			}
		}
		if !found {
			t.Errorf("%s: no verify node", name)
		}
	}
}

func TestSustainShape(t *testing.T) {
	g, _ := load(t, "sustain-retest")
	re, _ := g.Node("reaudit")
	if re.Kind != graph.KindCheck || !strings.Contains(re.Run, "auditor reaudit --json") {
		t.Errorf("reaudit must be a check running auditor reaudit --json: %+v", re)
	}
	ev, _ := g.Node("evals")
	if ev.Kind != graph.KindCheck || !strings.Contains(ev.Run, ".factory/config.json") {
		t.Errorf("evals must be a check reading eval commands from repo config: %+v", ev)
	}
	if n, _ := g.Node("report"); n.Kind != graph.KindAgent {
		t.Errorf("report must be an agent node")
	}
	if n, _ := g.Node("signoff"); n.Kind != graph.KindHuman {
		t.Errorf("signoff must be a human node")
	}
	for _, step := range [][2]string{{"reaudit", "evals"}, {"evals", "report"}, {"report", "verify"}, {"verify", "signoff"}} {
		if to, err := g.Next(step[0], graph.Pass); err != nil || to != step[1] {
			t.Errorf("%s pass goes to %q (%v), want %s", step[0], to, err, step[1])
		}
	}
}

func TestSustainReportTemplateHasNoRunFigures(t *testing.T) {
	g, text := load(t, "sustain-retest")
	n, _ := g.Node("report")
	if n.Prompt == "" {
		t.Fatal("report node has no prompt template")
	}
	if m := costWords.FindString(n.Prompt); m != "" {
		t.Errorf("report template contains %q", m)
	}
	if err := graph.ValidateTemplate(n.Prompt); err != nil {
		t.Error(err)
	}
	if strings.Contains(text, "{{ model") || strings.Contains(text, "{{model") {
		t.Error("model placeholder in workflow")
	}
}

func TestDesignShape(t *testing.T) {
	g, _ := load(t, "design-to-pr")
	d, _ := g.Node("design")
	if len(d.MCP) != 1 || d.MCP[0] != "penpot" || !strings.Contains(d.Prompt, "screenshot") {
		t.Errorf("design node must use the penpot mcp and accept a screenshot path: %+v", d)
	}
	v, _ := g.Node("visual")
	if v.Kind != graph.KindCheck || !strings.Contains(v.Run, "FACTORY_GATES:") {
		t.Errorf("visual must be a check on a FACTORY_GATES: line: %+v", v)
	}
	if to, _ := g.Next("build", graph.Pass); to != "visual" {
		t.Errorf("build goes to %q, want visual", to)
	}
	if to, _ := g.Next("visual", graph.Pass); to != "verify" {
		t.Errorf("visual passes to %q, want verify", to)
	}
	if to, _ := g.Next("visual", graph.Fail); to != "build" {
		t.Errorf("visual fails to %q, want build", to)
	}
}
