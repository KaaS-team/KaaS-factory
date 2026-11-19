// Package browsercheck drives headless Chrome through a list of steps and reports one
// FACTORY_GATES line. ParseSteps reads the YAML step list, Run executes it and stops at the
// first failing step, and Result.Line renders the gate line. The factory browsercheck command
// in cmd/factory is the caller.
package browsercheck

import (
	"errors"
	"fmt"
	"net/url"
	"strings"

	"gopkg.in/yaml.v3"
)

// Step is one parsed browser step.
type Step struct {
	Kind     string // goto, click, fill, type_secret, expect_text, expect_no_console_error or screenshot
	URL      string // goto target
	Selector string // click and fill target
	Value    string // fill value
	Text     string // expect_text needle
	Name     string // screenshot file name without extension, or the secret name for type_secret
}

// ParseSteps reads a YAML list of single-key step maps and validates each one.
func ParseSteps(data []byte) ([]Step, error) {
	var raw []map[string]yaml.Node
	if err := yaml.Unmarshal(data, &raw); err != nil {
		return nil, errors.New("steps must be a YAML list of maps")
	}
	if raw == nil && !strings.HasPrefix(strings.TrimSpace(string(data)), "[") {
		return nil, errors.New("steps must be a YAML list")
	}
	if len(raw) == 0 {
		return nil, errors.New("no steps")
	}
	steps := make([]Step, 0, len(raw))
	for i, m := range raw {
		s, err := parseStep(m)
		if err != nil {
			return nil, fmt.Errorf("step %d: %w", i+1, err)
		}
		steps = append(steps, s)
	}
	return steps, nil
}

// parseStep checks one single-key step map. Each kind has its own parser.
func parseStep(m map[string]yaml.Node) (Step, error) {
	if len(m) != 1 {
		return Step{}, errors.New("want exactly one key")
	}
	for kind, n := range m {
		parse, ok := stepParsers[kind]
		if !ok {
			return Step{Kind: kind}, fmt.Errorf("unknown step %q", kind)
		}
		s := Step{Kind: kind}
		return s, parse(&s, &n)
	}
	return Step{}, nil
}

var stepParsers = map[string]func(*Step, *yaml.Node) error{
	"goto":                    parseGoto,
	"click":                   parseClick,
	"fill":                    parseFill,
	"type_secret":             parseTypeSecret,
	"expect_text":             parseExpectText,
	"expect_no_console_error": func(*Step, *yaml.Node) error { return nil }, // the key alone turns the check on
	"screenshot":              parseScreenshot,
}

func parseGoto(s *Step, n *yaml.Node) error {
	if err := n.Decode(&s.URL); err != nil {
		return err
	}
	u, err := url.Parse(s.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return errors.New("goto needs an http or https URL")
	}
	return nil
}

func parseClick(s *Step, n *yaml.Node) error {
	if err := n.Decode(&s.Selector); err != nil {
		return err
	}
	if s.Selector == "" {
		return errors.New("click needs a selector")
	}
	return nil
}

func parseFill(s *Step, n *yaml.Node) error {
	var f struct {
		Selector string  `yaml:"selector"`
		Value    *string `yaml:"value"`
	}
	if err := n.Decode(&f); err != nil {
		return err
	}
	if f.Selector == "" {
		return errors.New("fill needs a selector")
	}
	if f.Value == nil {
		return errors.New("fill needs a value")
	}
	s.Selector, s.Value = f.Selector, *f.Value
	return nil
}

func parseTypeSecret(s *Step, n *yaml.Node) error {
	var f struct {
		Name     string `yaml:"name"`
		Selector string `yaml:"selector"`
	}
	if err := n.Decode(&f); err != nil {
		return errors.New("type_secret needs {name, selector}")
	}
	if f.Name == "" || f.Selector == "" {
		return errors.New("type_secret needs a name and a selector")
	}
	s.Name, s.Selector = f.Name, f.Selector
	return nil
}

func parseExpectText(s *Step, n *yaml.Node) error {
	if err := n.Decode(&s.Text); err != nil {
		return err
	}
	if s.Text == "" {
		return errors.New("expect_text needs text")
	}
	return nil
}

func parseScreenshot(s *Step, n *yaml.Node) error {
	if err := n.Decode(&s.Name); err != nil {
		return err
	}
	if s.Name == "" || strings.ContainsAny(s.Name, `/\`) || strings.Contains(s.Name, "..") {
		return errors.New("screenshot name must be a plain file name")
	}
	return nil
}
