package plan

import (
	"fmt"
	"strings"
)

// Markdown renders a plan for a human to approve: each wave (tickets that can run in parallel), each
// ticket with its Problem, Acceptance, Files and dependencies, then a Mermaid graph.
// It trusts waves from Waves, so call it on a plan with no Problems.
func Markdown(p Plan, waves [][]string) string {
	by := p.byID()
	var b strings.Builder
	for i, wave := range waves {
		fmt.Fprintf(&b, "## Wave %d\n\n", i+1)
		for _, id := range wave {
			t := by[id]
			fmt.Fprintf(&b, "### %s: %s\n\n", t.ID, t.Title)
			fmt.Fprintf(&b, "**Problem:** %s\n\n", oneLine(t.Body.section("Why")))
			b.WriteString("**Acceptance:**\n")
			for _, l := range t.Body.acceptanceLines() {
				fmt.Fprintf(&b, "- %s\n", l)
			}
			fmt.Fprintf(&b, "\nFiles: %s\n", codeList(t.Files))
			fmt.Fprintf(&b, "Depends on: %s\n\n", depList(t.Depends))
		}
	}
	b.WriteString(Mermaid(p, waves))
	return b.String()
}

// Mermaid draws one node per ticket and an arrow from each dependency to the ticket that waits for it.
func Mermaid(p Plan, waves [][]string) string {
	by := p.byID()
	var b strings.Builder
	b.WriteString("```mermaid\ngraph TD\n")
	for _, wave := range waves {
		for _, id := range wave {
			fmt.Fprintf(&b, "  %s[\"%s: %s\"]\n", id, id, strings.ReplaceAll(by[id].Title, `"`, "'"))
		}
	}
	for _, wave := range waves {
		for _, id := range wave {
			for _, d := range by[id].Depends {
				fmt.Fprintf(&b, "  %s --> %s\n", d, id)
			}
		}
	}
	b.WriteString("```\n")
	return b.String()
}

func (b Body) section(name string) string {
	s, ok := b.Section(name)
	if !ok {
		return ""
	}
	return s.Text()
}

// acceptanceLines returns the "AC-n: text" lines under "## Acceptance", without the list dash.
func (b Body) acceptanceLines() []string {
	var out []string
	for _, l := range strings.Split(b.section("Acceptance"), "\n") {
		if acLine.MatchString(l) {
			out = append(out, strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(l), "-")))
		}
	}
	return out
}

func oneLine(s string) string { return strings.Join(strings.Fields(s), " ") }

func codeList(ss []string) string {
	q := make([]string, len(ss))
	for i, s := range ss {
		q[i] = "`" + s + "`"
	}
	return strings.Join(q, ", ")
}

func depList(ss []string) string {
	if len(ss) == 0 {
		return "none"
	}
	return strings.Join(ss, ", ")
}
