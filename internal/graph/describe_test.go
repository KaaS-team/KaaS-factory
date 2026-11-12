package graph

import "fmt"

// describe lists nodes then edges, one per line, in a stable text form for golden files.
func describe(g *Graph) string {
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
