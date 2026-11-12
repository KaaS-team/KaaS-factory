package graph

import (
	"fmt"

	"gopkg.in/yaml.v3"
)

// readAgentKeys reads a step's tier, budget and skills keys and its prompt position from its YAML
// mapping. An error names the key and its file line (lineOff is the count of file lines before the YAML).
func (s *namedStep) readAgentKeys(node *yaml.Node, lineOff int) error {
	for j := 0; j+1 < len(node.Content); j += 2 {
		k, v := node.Content[j].Value, node.Content[j+1]
		line := node.Content[j].Line + lineOff
		switch k {
		case "tier":
			t, err := tierValue(v)
			if err != nil {
				return fmt.Errorf("line %d: key %q %w", line, k, err)
			}
			s.tier, s.keyLine[k] = t, line
		case "budget":
			var n int
			if v.Kind != yaml.ScalarNode || v.Tag != "!!int" || v.Decode(&n) != nil || n <= 0 {
				return fmt.Errorf("line %d: key %q must be a whole number of tokens above zero", line, k)
			}
			s.budget, s.keyLine[k] = n, line
		case "skills":
			if v.Kind != yaml.SequenceNode {
				return fmt.Errorf("line %d: key %q must be a list of skill names", line, k)
			}
			var names []string
			for _, c := range v.Content {
				if c.Kind != yaml.ScalarNode || c.Value == "" {
					return fmt.Errorf("line %d: key %q must be a list of skill names", line, k)
				}
				names = append(names, c.Value)
			}
			s.skills, s.keyLine[k] = names, line
		case "prompt":
			s.promptLine = v.Line + lineOff
			if v.Style&(yaml.LiteralStyle|yaml.FoldedStyle) != 0 {
				s.promptLine++ // the text starts on the line after the | or > header
			}
		}
	}
	return nil
}

func tierValue(v *yaml.Node) (string, error) {
	if v.Kind == yaml.ScalarNode && (v.Value == "small" || v.Value == "large") {
		return v.Value, nil
	}
	return "", fmt.Errorf("must be small or large")
}

// oldTier maps a tier of the old agents map to the node tier. None, and so a check step, has no tier.
func oldTier(t string) (string, bool) {
	switch t {
	case "small", "light":
		return "small", true
	case "large", "standard", "deep":
		return "large", true
	case "", "none":
		return "", true
	}
	return "", false
}

// applyAgentsMap folds the deprecated top-level agents map into steps that do not set the key
// themselves, and records a warning. The steps are changed in place.
func (g *Graph) applyAgentsMap(m *yaml.Node, steps []namedStep) error {
	am := child(m, "agents")
	if am == nil {
		return nil
	}
	if am.Kind != yaml.MappingNode {
		return fmt.Errorf("agents must be a map of step id to settings")
	}
	g.Warnings = append(g.Warnings, agentsDeprecated)
	for i := 0; i+1 < len(am.Content); i += 2 {
		id := am.Content[i].Value
		var a struct {
			Tier   string   `yaml:"tier"`
			Skills []string `yaml:"skills"`
		}
		if err := am.Content[i+1].Decode(&a); err != nil {
			return fmt.Errorf("agents %s: %w", id, err)
		}
		idx := -1
		for j := range steps {
			if steps[j].id == id {
				idx = j
			}
		}
		if idx < 0 {
			return fmt.Errorf("agents: entry %q names no step", id)
		}
		tier, ok := oldTier(a.Tier)
		if !ok {
			return fmt.Errorf("agents %s: tier %q is not small, large, light, standard, deep or none", id, a.Tier)
		}
		st := &steps[idx]
		if st.tier == "" && tier != "" {
			st.tier = tier
		}
		if st.skills == nil && len(a.Skills) > 0 {
			st.skills = a.Skills
		}
	}
	return nil
}
