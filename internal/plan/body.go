// Package plan parses and renders the planned issue body v1 and checks a set of tickets as a DAG.
// Wire formats match the TS factory's src/engine/import-plan.ts and src/orchestrate/groom.ts.
package plan

import (
	"regexp"
	"strings"
)

// Marker opens every planned body.
const Marker = "<!-- factory:planned v1 -->"

// markerError is the TS wording, which ends in a period.
type markerError struct{}

// Error returns the TS message for a body without the marker.
func (markerError) Error() string { return "The body does not start with " + Marker + "." }

// ErrNoMarker is returned by ParseBody when the body lacks the planned marker.
var ErrNoMarker error = markerError{}

// Section is one "## " block of a body, kept as the exact text from its heading line to the next one.
type Section struct {
	Raw string
}

// Heading returns the section's heading text without the "## " prefix.
func (s Section) Heading() string {
	line, _, _ := strings.Cut(s.Raw, "\n")
	return strings.TrimSpace(strings.TrimPrefix(line, "## "))
}

// Text returns everything after the heading line.
func (s Section) Text() string {
	_, rest, _ := strings.Cut(s.Raw, "\n")
	return rest
}

// Body is a planned body split into the text before the first "## " heading and its sections.
type Body struct {
	Preface  string
	Sections []Section
}

// ParseBody splits a planned body without losing a byte; it errors when the marker is missing.
func ParseBody(text string) (Body, error) {
	if !strings.HasPrefix(strings.TrimLeft(text, " \t\r\n"), Marker) {
		return Body{}, ErrNoMarker
	}
	var starts []int
	for i := 0; i < len(text); {
		if strings.HasPrefix(text[i:], "## ") {
			starts = append(starts, i)
		}
		nl := strings.IndexByte(text[i:], '\n')
		if nl < 0 {
			break
		}
		i += nl + 1
	}
	if len(starts) == 0 {
		return Body{Preface: text}, nil
	}
	b := Body{Preface: text[:starts[0]]}
	for i, s := range starts {
		end := len(text)
		if i+1 < len(starts) {
			end = starts[i+1]
		}
		b.Sections = append(b.Sections, Section{Raw: text[s:end]})
	}
	return b, nil
}

// Render joins the body back into the exact text ParseBody read.
func (b Body) Render() string {
	var sb strings.Builder
	sb.WriteString(b.Preface)
	for _, s := range b.Sections {
		sb.WriteString(s.Raw)
	}
	return sb.String()
}

// Section returns the first section whose heading, before any colon, equals name ignoring case.
func (b Body) Section(name string) (Section, bool) {
	for _, s := range b.Sections {
		h, _, _ := strings.Cut(s.Heading(), ":")
		if strings.EqualFold(strings.TrimSpace(h), name) {
			return s, true
		}
	}
	return Section{}, false
}

var (
	fileLine = regexp.MustCompile("^\\s*-\\s+`([^`]+)`")
	acLine   = regexp.MustCompile(`^\s*-\s*(AC-\d+):`)
	depsLine = regexp.MustCompile(`(?im)^Deps:[ \t]*(.*)$`)
)

// Files returns the backticked paths listed under "## Files".
func (b Body) Files() []string {
	s, ok := b.Section("Files")
	if !ok {
		return nil
	}
	var out []string
	for _, l := range strings.Split(s.Text(), "\n") {
		if m := fileLine.FindStringSubmatch(l); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// UsesFiles returns the backticked paths listed under "## Uses": the repo files the ticket reads.
func (b Body) UsesFiles() []string {
	s, ok := b.Section("Uses")
	if !ok {
		return nil
	}
	var out []string
	for _, l := range strings.Split(s.Text(), "\n") {
		if m := fileLine.FindStringSubmatch(l); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// Acceptance returns the ids of the "- AC-n:" lines under "## Acceptance".
func (b Body) Acceptance() []string {
	s, ok := b.Section("Acceptance")
	if !ok {
		return nil
	}
	var out []string
	for _, l := range strings.Split(s.Text(), "\n") {
		if m := acLine.FindStringSubmatch(l); m != nil {
			out = append(out, m[1])
		}
	}
	return out
}

// Deps returns the tokens of the header "Deps:" line, before the first section; "none" is dropped.
func (b Body) Deps() []string {
	m := depsLine.FindStringSubmatch(b.Preface)
	if m == nil {
		return nil
	}
	var out []string
	for _, tok := range strings.FieldsFunc(m[1], func(r rune) bool { return r == ',' || r == ' ' || r == '\t' }) {
		if tok != "none" {
			out = append(out, tok)
		}
	}
	return out
}
