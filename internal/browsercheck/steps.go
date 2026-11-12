// Package browsercheck drives headless Chrome through a list of steps and reports one FACTORY_GATES line.
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
	Kind     string // goto, click, fill, expect_text, expect_no_console_error or screenshot
	URL      string // goto target
	Selector string // click and fill target
	Value    string // fill value
	Text     string // expect_text needle
	Name     string // screenshot file name without extension
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

func parseStep(m map[string]yaml.Node) (Step, error) {
	if len(m) != 1 {
		return Step{}, errors.New("want exactly one key")
	}
	for kind, n := range m {
		s := Step{Kind: kind}
		switch kind {
		case "goto":
			if err := n.Decode(&s.URL); err != nil {
				return s, err
			}
			u, err := url.Parse(s.URL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
				return s, errors.New("goto needs an http or https URL")
			}
		case "click":
			if err := n.Decode(&s.Selector); err != nil {
				return s, err
			}
			if s.Selector == "" {
				return s, errors.New("click needs a selector")
			}
		case "fill":
			var f struct {
				Selector string  `yaml:"selector"`
				Value    *string `yaml:"value"`
			}
			if err := n.Decode(&f); err != nil {
				return s, err
			}
			if f.Selector == "" {
				return s, errors.New("fill needs a selector")
			}
			if f.Value == nil {
				return s, errors.New("fill needs a value")
			}
			s.Selector, s.Value = f.Selector, *f.Value
		case "expect_text":
			if err := n.Decode(&s.Text); err != nil {
				return s, err
			}
			if s.Text == "" {
				return s, errors.New("expect_text needs text")
			}
		case "expect_no_console_error":
			// the value is ignored; the key alone turns the check on
		case "screenshot":
			if err := n.Decode(&s.Name); err != nil {
				return s, err
			}
			if s.Name == "" || strings.ContainsAny(s.Name, `/\`) || strings.Contains(s.Name, "..") {
				return s, errors.New("screenshot name must be a plain file name")
			}
		default:
			return s, fmt.Errorf("unknown step %q", kind)
		}
		return s, nil
	}
	return Step{}, nil
}
