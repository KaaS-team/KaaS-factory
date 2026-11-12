package migration

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

// PackType is the required value of a pack's type field.
const PackType = "specs.factory/migration"

var nameRe = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z][A-Za-z0-9_-]*)*$`)

// Pack is one parsed migration pack.
type Pack struct {
	Type          string      `yaml:"type"`
	Name          string      `yaml:"name"`
	DisplayName   string      `yaml:"displayName"`
	Description   string      `yaml:"description"`
	Tags          []string    `yaml:"tags"`
	Preconditions []Predicate `yaml:"preconditions"`
	Steps         []Step      `yaml:"steps"`
}

// Step is one command, one model prompt, or a group of nested steps. Files gates the files it sees.
type Step struct {
	Name   string      `yaml:"name"`
	Files  []Predicate `yaml:"files"`
	Run    []string    `yaml:"run"`
	Prompt string      `yaml:"prompt"`
	Steps  []Step      `yaml:"steps"`
}

// Load parses and validates a pack. Unknown fields are errors.
func Load(b []byte) (*Pack, error) {
	var p Pack
	dec := yaml.NewDecoder(bytes.NewReader(b))
	dec.KnownFields(true)
	if err := dec.Decode(&p); err != nil {
		if errors.Is(err, io.EOF) {
			err = fmt.Errorf("empty file")
		}
		return nil, fmt.Errorf("pack yaml: %w", err)
	}
	if err := p.validate(); err != nil {
		return nil, fmt.Errorf("pack %q: %w", p.Name, err)
	}
	return &p, nil
}

func (p *Pack) validate() error {
	switch {
	case p.Type != PackType:
		return fmt.Errorf("type must be %s", PackType)
	case !nameRe.MatchString(p.Name):
		return fmt.Errorf("name must be a dotted identifier")
	case strings.TrimSpace(p.Description) == "":
		return fmt.Errorf("description is required")
	case len(p.Steps) == 0:
		return fmt.Errorf("steps: at least one step")
	}
	return validateSteps(p.Steps, "")
}

func validateSteps(steps []Step, parent string) error {
	seen := map[string]bool{}
	for _, s := range steps {
		if s.Name == "" {
			return fmt.Errorf("%sa step has no name", parent)
		}
		if seen[s.Name] {
			return fmt.Errorf("duplicate step name %s%s", parent, s.Name)
		}
		seen[s.Name] = true
		n := 0
		for _, set := range []bool{len(s.Run) > 0, s.Prompt != "", len(s.Steps) > 0} {
			if set {
				n++
			}
		}
		if n != 1 {
			return fmt.Errorf("step %s%s needs exactly one of run, prompt, steps", parent, s.Name)
		}
		if err := validateSteps(s.Steps, parent+s.Name+"/"); err != nil {
			return err
		}
	}
	return nil
}

// Leaf is one runnable step with its slash path and the predicates inherited from its groups.
type Leaf struct {
	Path  string
	Step  Step
	Files []Predicate
}

// Flatten lists the runnable steps in order. A nested step inherits its parents' file predicates.
func (p *Pack) Flatten() []Leaf {
	var out []Leaf
	var walk func(steps []Step, prefix string, inherit []Predicate)
	walk = func(steps []Step, prefix string, inherit []Predicate) {
		for _, s := range steps {
			gate := append(append([]Predicate(nil), inherit...), s.Files...)
			if len(s.Steps) > 0 {
				walk(s.Steps, prefix+s.Name+"/", gate)
				continue
			}
			out = append(out, Leaf{Path: prefix + s.Name, Step: s, Files: gate})
		}
	}
	walk(p.Steps, "", p.Preconditions)
	return out
}
