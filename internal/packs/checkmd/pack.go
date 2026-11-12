// Ported from continuedev/continue@5522c6f core/llm/rules/getSystemMessageWithRules.ts

// Package checkmd reads markdown check packs and decides which of them apply to a diff.
package checkmd

import (
	"bytes"
	"fmt"
	"path"
	"regexp"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	"gopkg.in/yaml.v3"
)

// Pack is one check: front matter plus the prompt body.
type Pack struct {
	Name        string
	Description string
	Globs       []string // a leading "!" negates a pattern
	Regex       []string // content patterns; any one matching is enough
	Dir         string   // directory the pack is colocated in; empty means repo-wide
	Body        string
	re          []*regexp.Regexp
}

type frontMatter struct {
	Name        string    `yaml:"name"`
	Description string    `yaml:"description"`
	Globs       listOrOne `yaml:"globs"`
	Regex       listOrOne `yaml:"regex"`
}

// listOrOne decodes a YAML string or a list of strings.
type listOrOne []string

func (l *listOrOne) UnmarshalYAML(n *yaml.Node) error {
	if n.Kind == yaml.ScalarNode {
		*l = listOrOne{n.Value}
		return nil
	}
	return n.Decode((*[]string)(l))
}

// Parse reads a pack from markdown with YAML front matter; dir is the directory the file lives in, relative to the repo root.
func Parse(dir string, src []byte) (Pack, error) {
	rest, ok := bytes.CutPrefix(src, []byte("---\n"))
	head, body, found := bytes.Cut(rest, []byte("\n---\n"))
	if !ok || !found {
		return Pack{}, fmt.Errorf("checkmd: missing front matter")
	}
	var fm frontMatter
	if err := yaml.Unmarshal(head, &fm); err != nil {
		return Pack{}, fmt.Errorf("checkmd: front matter: %w", err)
	}
	if fm.Name == "" {
		return Pack{}, fmt.Errorf("checkmd: front matter needs a name")
	}
	p := Pack{Name: fm.Name, Description: fm.Description, Globs: fm.Globs, Regex: fm.Regex, Dir: dir, Body: string(body)}
	return p, p.compile()
}

func (p *Pack) compile() error {
	p.re = nil
	for _, r := range p.Regex {
		c, err := regexp.Compile(r)
		if err != nil {
			return fmt.Errorf("checkmd: %s: regex %q: %w", p.Name, r, err)
		}
		p.re = append(p.re, c)
	}
	return nil
}

// Applies reports whether the pack covers the changed files: it is colocated with one of them,
// a glob matches one, and when regex is set a matching file's content matches too.
func (p Pack) Applies(files []string, contents map[string]string) bool {
	if dir := path.Clean(p.Dir); p.Dir != "" && dir != "." {
		var in []string
		for _, f := range files {
			if strings.HasPrefix(path.Clean(f), dir+"/") {
				in = append(in, f)
			}
		}
		files = in
	}
	var hit []string
	for _, f := range files {
		if matchGlobs(f, p.Globs) {
			hit = append(hit, f)
		}
	}
	if len(hit) == 0 {
		return false
	}
	if len(p.re) == 0 {
		return true
	}
	for _, f := range hit {
		for _, re := range p.re {
			if c := contents[f]; c != "" && re.MatchString(c) {
				return true
			}
		}
	}
	return false
}

// matchGlobs is true when no negated glob matches and either a positive glob matches or only negated globs are given.
func matchGlobs(file string, globs []string) bool {
	allowed := true // flips to "need a positive match" once a positive glob exists
	matched := false
	for _, g := range globs {
		neg, isNeg := strings.CutPrefix(g, "!")
		m, _ := doublestar.Match(neg, file)
		switch {
		case isNeg && m:
			return false
		case !isNeg:
			allowed = false
			matched = matched || m
		}
	}
	return allowed || matched
}

// Select keeps the packs that apply to the changed files, in order.
func Select(packs []Pack, files []string, contents map[string]string) []Pack {
	var out []Pack
	for _, p := range packs {
		if p.Applies(files, contents) {
			out = append(out, p)
		}
	}
	return out
}
