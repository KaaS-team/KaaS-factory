package graph

import (
	"strings"
	"testing"
)

// Symphony spec section 5.4: unknown variables and unknown filters fail rendering.
func TestRender(t *testing.T) {
	vars := map[string]any{
		"issue":   map[string]any{"title": "Crash", "labels": "a", "n": 7},
		"attempt": nil,
	}
	cases := []struct {
		name, tmpl, want, errHas string
	}{
		{"plain", "no vars", "no vars", ""},
		{"nested", "T: {{ issue.title }}", "T: Crash", ""},
		{"no spaces", "{{issue.n}}", "7", ""},
		{"nil is empty", "[{{ attempt }}]", "[]", ""},
		{"filter", "{{ issue.title | upcase }}", "CRASH", ""},
		{"unknown root", "{{ ticket.title }}", "", "ticket.title"},
		{"unknown nested", "{{ issue.assignee }}", "", "issue.assignee"},
		{"into a scalar", "{{ issue.title.x }}", "", "issue.title.x"},
		{"unknown filter", "{{ issue.title | shout }}", "", "shout"},
		{"unclosed", "{{ issue.title", "", "template_parse_error"},
		{"empty", "{{ }}", "", "template_parse_error"},
		{"bad name", "{{ issue..title }}", "", "template_parse_error"},
		{"tag", "{% if x %}", "", "template_parse_error"},
	}
	for _, c := range cases {
		got, err := Render(c.tmpl, vars)
		if c.errHas == "" {
			if err != nil || got != c.want {
				t.Errorf("%s: %q, %v", c.name, got, err)
			}
			continue
		}
		if err == nil || !strings.Contains(err.Error(), c.errHas) {
			t.Errorf("%s: want error with %q, got %q, %v", c.name, c.errHas, got, err)
		}
	}
}

func TestUnknownVariableInWorkflowPromptNamesTheVariable(t *testing.T) {
	in := "steps:\n  a: { uses: triage, prompt: 'Look at {{ issue.title }} and {{ repo_name }}' }\n"
	_, err := ParseYAML("w", []byte(in))
	if err == nil || !strings.Contains(err.Error(), "repo_name") {
		t.Fatalf("load: %v", err)
	}
	g, err := ParseYAML("w", []byte("steps:\n  a: { uses: triage, prompt: 'Look at {{ issue.title }}' }\n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := g.RenderPrompt("a", map[string]any{"issue": map[string]any{}}); err == nil || !strings.Contains(err.Error(), "issue.title") {
		t.Errorf("render: %v", err)
	}
	if _, err := g.RenderPrompt("zzz", nil); err == nil {
		t.Error("unknown node accepted")
	}
}
