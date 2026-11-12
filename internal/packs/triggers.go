// Ported from OpenHands/software-agent-sdk@10be259c4fc89b23999e8c653f2130a358e02116 openhands-sdk/openhands/sdk/skills/skill.py
package packs

import (
	"fmt"
	"regexp"
	"strings"
)

// globRegex compiles a gitignore-style glob into an anchored regexp: ** crosses slashes, * and ? stay
// inside one segment, and a pattern with no slash matches at any depth. "**/" also matches zero segments.
func globRegex(pattern string) (*regexp.Regexp, error) {
	if !strings.Contains(pattern, "/") {
		pattern = "**/" + pattern
	}
	var b strings.Builder
	b.WriteString(`(?s)\A`)
	for i := 0; i < len(pattern); i++ {
		switch c := pattern[i]; {
		case strings.HasPrefix(pattern[i:], "**/"):
			b.WriteString(`(?:.*/)?`)
			i += 2
		case strings.HasPrefix(pattern[i:], "**"):
			b.WriteString(`.*`)
			i++
		case c == '*':
			b.WriteString(`[^/]*`)
		case c == '?':
			b.WriteString(`[^/]`)
		default:
			b.WriteString(regexp.QuoteMeta(string(c)))
		}
	}
	b.WriteString(`\z`)
	return regexp.Compile(b.String())
}

// PathMatchesGlob reports whether the POSIX path matches the gitignore-style glob. Matching is case sensitive.
func PathMatchesGlob(path, pattern string) bool {
	if pattern == "" {
		return false
	}
	re, err := globRegex(pattern)
	return err == nil && re.MatchString(path)
}

// KeywordMatches reports whether keyword appears in message as a whole token, ignoring case.
// Alphanumeric boundaries are used, so "git" does not match "github" and "/linear" still matches.
func KeywordMatches(keyword, message string) bool {
	if keyword == "" {
		return false
	}
	kw, msg := strings.ToLower(keyword), strings.ToLower(message)
	for from := 0; ; {
		i := strings.Index(msg[from:], kw)
		if i < 0 {
			return false
		}
		start, end := from+i, from+i+len(kw)
		if !alnumAt(msg, start-1) && !alnumAt(msg, end) {
			return true
		}
		from = start + 1
	}
}

func alnumAt(s string, i int) bool {
	if i < 0 || i >= len(s) {
		return false
	}
	c := s[i]
	return c >= 'a' && c <= 'z' || c >= '0' && c <= '9'
}

func validateTriggers(paths, keywords []string) error {
	for _, p := range paths {
		if p == "" {
			return fmt.Errorf("paths: empty glob")
		}
		if _, err := globRegex(p); err != nil {
			return fmt.Errorf("paths: bad glob %q: %w", p, err)
		}
	}
	for _, k := range keywords {
		if k == "" {
			return fmt.Errorf("keywords: empty keyword")
		}
	}
	return nil
}

// Triggered reports whether the manifest has triggers and one of them matches a touched path or the text.
func (m Manifest) Triggered(paths []string, text string) bool {
	for _, g := range m.Paths {
		for _, p := range paths {
			if PathMatchesGlob(p, g) {
				return true
			}
		}
	}
	for _, k := range m.Keywords {
		if KeywordMatches(k, text) {
			return true
		}
	}
	return false
}

// Inject returns the skills whose body belongs in the prompt: a skill with no paths or keywords always,
// one with triggers only when a touched path or the text matches. Other kinds are never returned.
func Inject(skills []Manifest, paths []string, text string) []Manifest {
	var out []Manifest
	for _, m := range skills {
		if m.Kind != KindSkill {
			continue
		}
		if len(m.Paths) == 0 && len(m.Keywords) == 0 || m.Triggered(paths, text) {
			out = append(out, m)
		}
	}
	return out
}
