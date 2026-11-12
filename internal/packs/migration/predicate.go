package migration

import (
	"fmt"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// Predicate is one file gate. Exactly one field is set.
type Predicate struct {
	And      []Predicate
	Or       []Predicate
	Not      *Predicate
	Glob     string
	Contains string
	Dep      *Dependency

	glob *regexp.Regexp
	re   *regexp.Regexp
}

// Dependency asks whether a manifest lists a dependency, optionally within a version range.
type Dependency struct {
	Name     string `yaml:"name"`
	Manifest string `yaml:"manifest"`
	Version  string `yaml:"version"`

	rng []comparator
}

// UnmarshalYAML reads a predicate map and rejects unknown keys, many keys and bad arguments.
func (p *Predicate) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind != yaml.MappingNode || len(n.Content) != 2 {
		return fmt.Errorf("line %d: a predicate is a map with one key", n.Line)
	}
	key, val := n.Content[0].Value, n.Content[1]
	var err error
	switch key {
	case "and":
		p.And, err = decodeList(val)
	case "or":
		p.Or, err = decodeList(val)
	case "not":
		p.Not = new(Predicate)
		err = val.Decode(p.Not)
	case "glob":
		err = val.Decode(&p.Glob)
		if err == nil {
			p.glob, err = compileGlob(p.Glob)
		}
	case "contains":
		err = val.Decode(&p.Contains)
		if err == nil {
			p.re, err = regexp.Compile(p.Contains)
		}
	case "dependency":
		p.Dep = new(Dependency)
		dec := yaml.NewDecoder(strings.NewReader(nodeText(val)))
		dec.KnownFields(true)
		if err = dec.Decode(p.Dep); err == nil {
			err = p.Dep.check()
		}
	default:
		return fmt.Errorf("line %d: unknown predicate %q", n.Line, key)
	}
	if err != nil {
		return fmt.Errorf("line %d: %s: %w", n.Line, key, err)
	}
	return nil
}

func decodeList(n *yaml.Node) ([]Predicate, error) {
	var ps []Predicate
	if err := n.Decode(&ps); err != nil {
		return nil, err
	}
	if len(ps) == 0 {
		return nil, fmt.Errorf("needs at least one predicate")
	}
	return ps, nil
}

func nodeText(n *yaml.Node) string {
	b, _ := yaml.Marshal(n)
	return string(b)
}

func (d *Dependency) check() error {
	if d.Name == "" {
		return fmt.Errorf("name is required")
	}
	switch d.Manifest {
	case "", "package.json", "go.mod":
	default:
		return fmt.Errorf("manifest %q: want package.json or go.mod", d.Manifest)
	}
	var err error
	d.rng, err = parseRange(d.Version)
	if err != nil {
		return fmt.Errorf("version: %w", err)
	}
	return nil
}

func compileGlob(g string) (*regexp.Regexp, error) {
	if g == "" {
		return nil, fmt.Errorf("empty glob")
	}
	var b strings.Builder
	b.WriteString("^")
	for i := 0; i < len(g); i++ {
		switch c := g[i]; {
		case c == '*' && strings.HasPrefix(g[i:], "**/"):
			b.WriteString("(?:.*/)?")
			i += 2
		case c == '*' && strings.HasPrefix(g[i:], "**"):
			b.WriteString(".*")
			i++
		case c == '*':
			b.WriteString("[^/]*")
		case c == '?':
			b.WriteString("[^/]")
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString("$")
	return regexp.Compile(b.String())
}
