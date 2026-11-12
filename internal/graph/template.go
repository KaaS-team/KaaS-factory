package graph

import (
	"fmt"
	"strings"
)

// KnownVars are the root variables a prompt template may use (Symphony section 5.4).
var KnownVars = []string{"issue", "attempt", "node", "workflow"}

var filters = map[string]func(string) string{"upcase": strings.ToUpper, "downcase": strings.ToLower}

type tmplPart struct {
	text string // literal text when path is nil
	path []string
	fn   []string
}

func parseTemplate(tmpl string) ([]tmplPart, error) {
	var parts []tmplPart
	for tmpl != "" {
		i := strings.Index(tmpl, "{{")
		j := strings.Index(tmpl, "{%")
		if j >= 0 && (i < 0 || j < i) {
			return nil, fmt.Errorf("template_parse_error: tags are not supported: %s", strings.SplitN(tmpl[j:], "%}", 2)[0])
		}
		if i < 0 {
			parts = append(parts, tmplPart{text: tmpl})
			break
		}
		if i > 0 {
			parts = append(parts, tmplPart{text: tmpl[:i]})
		}
		rest := tmpl[i+2:]
		k := strings.Index(rest, "}}")
		if k < 0 {
			return nil, fmt.Errorf("template_parse_error: unclosed {{")
		}
		expr := strings.Split(rest[:k], "|")
		name := strings.TrimSpace(expr[0])
		if name == "" {
			return nil, fmt.Errorf("template_parse_error: empty {{ }}")
		}
		p := tmplPart{path: strings.Split(name, ".")}
		for _, seg := range p.path {
			if seg == "" || strings.ContainsAny(seg, " \t\n\"'[]()") {
				return nil, fmt.Errorf("template_parse_error: bad variable %q", name)
			}
		}
		for _, f := range expr[1:] {
			f = strings.TrimSpace(f)
			if _, ok := filters[f]; !ok {
				return nil, fmt.Errorf("template_render_error: unknown filter %q", f)
			}
			p.fn = append(p.fn, f)
		}
		parts = append(parts, p)
		tmpl = rest[k+2:]
	}
	return parts, nil
}

// ValidateTemplate parses tmpl and fails on an unknown root variable or filter, naming it.
func ValidateTemplate(tmpl string) error {
	parts, err := parseTemplate(tmpl)
	if err != nil {
		return err
	}
	for _, p := range parts {
		if p.path == nil {
			continue
		}
		known := false
		for _, k := range KnownVars {
			known = known || k == p.path[0]
		}
		if !known {
			return fmt.Errorf("template_render_error: unknown variable %q", strings.Join(p.path, "."))
		}
	}
	return nil
}

// Render fills {{ a.b }} placeholders from vars. An unknown variable or filter is an error naming it.
// A variable that is present and nil renders as the empty string.
func Render(tmpl string, vars map[string]any) (string, error) {
	parts, err := parseTemplate(tmpl)
	if err != nil {
		return "", err
	}
	var b strings.Builder
	for _, p := range parts {
		if p.path == nil {
			b.WriteString(p.text)
			continue
		}
		var cur any = vars
		for _, seg := range p.path {
			m, ok := cur.(map[string]any)
			if !ok {
				return "", fmt.Errorf("template_render_error: unknown variable %q", strings.Join(p.path, "."))
			}
			if cur, ok = m[seg]; !ok {
				return "", fmt.Errorf("template_render_error: unknown variable %q", strings.Join(p.path, "."))
			}
		}
		s := ""
		if cur != nil {
			s = fmt.Sprint(cur)
		}
		for _, f := range p.fn {
			s = filters[f](s)
		}
		b.WriteString(s)
	}
	return b.String(), nil
}

// RenderPrompt renders the node's prompt, else the workflow prompt, with vars.
func (g *Graph) RenderPrompt(node string, vars map[string]any) (string, error) {
	n, ok := g.Node(node)
	if !ok {
		return "", fmt.Errorf("graph %s: no node %q", g.Name, node)
	}
	tmpl := n.Prompt
	if tmpl == "" {
		tmpl = g.Prompt
	}
	return Render(tmpl, vars)
}

// validateTemplateAt is ValidateTemplate for text that starts on file line (0 leaves the line out); an
// unknown variable error carries the line it is on.
func validateTemplateAt(tmpl string, line int) error {
	err := ValidateTemplate(tmpl)
	if err == nil || line == 0 || strings.HasPrefix(err.Error(), "template_parse_error") {
		return err
	}
	for i, l := range strings.Split(tmpl, "\n") {
		if lerr := ValidateTemplate(l); lerr != nil {
			return fmt.Errorf("template_render_error: line %d: %s", line+i, strings.TrimPrefix(lerr.Error(), "template_render_error: "))
		}
	}
	return err
}
