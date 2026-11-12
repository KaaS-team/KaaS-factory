// Package lintdelta rejects an edit that adds linter errors the file did not have before the edit.
//
// The idea follows SWE-agent's windowed_edit_linting gate (diff the pre-edit and post-edit linter
// output); the code is written fresh in Go. Errors already in the file never block an edit.
package lintdelta

import (
	"context"
	"errors"
	"fmt"
	"go/parser"
	"go/scanner"
	"go/token"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

// Finding is one linter error. Line is 1-based.
type Finding struct {
	Line int
	Code string
	Text string
}

// Linter reports the errors in one file's content.
type Linter interface {
	Lint(ctx context.Context, path, content string) ([]Finding, error)
}

// Edit is the line range an edit replaced: lines Start..End of the old file (1-based, inclusive;
// End = Start-1 for a pure insert) were replaced by NewLines lines.
type Edit struct {
	Start, End, NewLines int
}

// Verdict is the outcome of one gate check.
type Verdict struct {
	Rejected bool
	New      []Finding // errors the edit added
	Before   string    // window of the old file around the edit, numbered
	After    string    // window of the new file around the edit, numbered
}

// Message renders a rejection for the agent: the new errors and both windows. It is empty when the edit passed.
func (v Verdict) Message() string {
	if !v.Rejected {
		return ""
	}
	var b strings.Builder
	b.WriteString("Your edit introduced new lint errors and was not applied:\n")
	for _, f := range v.New {
		fmt.Fprintf(&b, "- line %d %s %s\n", f.Line, f.Code, f.Text)
	}
	b.WriteString("\nThis is how the file looked before the edit:\n" + v.Before)
	b.WriteString("\nThis is how it would look after your edit:\n" + v.After)
	return b.String()
}

// windowPad is how many lines of context Check shows around an edit.
const windowPad = 3

// Check lints before and after and rejects the edit when the after set has an error the before set lacks.
// An error counts as the same one when its code and text match and its line, mapped through the edit, matches.
func Check(ctx context.Context, l Linter, path, before, after string, e Edit) (Verdict, error) {
	pre, err := l.Lint(ctx, path, before)
	if err != nil {
		return Verdict{}, err
	}
	post, err := l.Lint(ctx, path, after)
	if err != nil {
		return Verdict{}, err
	}
	delta := e.NewLines - (e.End - e.Start + 1)
	have := map[Finding]int{}
	for _, f := range pre {
		switch {
		case f.Line > e.End:
			f.Line += delta // below the edit: the line moved
		case f.Line >= e.Start:
			f.Line = 0 // inside the replaced range: it can match any line of the new text
		}
		have[f]++
	}
	var added []Finding
	for _, f := range post {
		key := f
		if f.Line >= e.Start && f.Line < e.Start+e.NewLines {
			key.Line = 0
		}
		if have[key] > 0 {
			have[key]--
			continue
		}
		added = append(added, f)
	}
	if len(added) == 0 {
		return Verdict{}, nil
	}
	return Verdict{
		Rejected: true,
		New:      added,
		Before:   window(before, e.Start, e.End),
		After:    window(after, e.Start, e.Start+e.NewLines-1),
	}, nil
}

func window(content string, start, end int) string {
	lines := strings.Split(content, "\n")
	lo, hi := max(start-windowPad, 1), min(end+windowPad, len(lines))
	var b strings.Builder
	for i := lo; i <= hi; i++ {
		fmt.Fprintf(&b, "%d\t%s\n", i, lines[i-1])
	}
	return b.String()
}

// GoSyntax lints Go files with the standard parser, so it needs no external tool.
type GoSyntax struct{}

// Lint returns the syntax errors of a Go file.
func (GoSyntax) Lint(_ context.Context, path, content string) ([]Finding, error) {
	_, err := parser.ParseFile(token.NewFileSet(), path, content, parser.SkipObjectResolution)
	if err == nil {
		return nil, nil
	}
	var list scanner.ErrorList
	if !errors.As(err, &list) {
		return nil, err
	}
	out := make([]Finding, 0, len(list))
	for _, e := range list {
		out = append(out, Finding{Line: e.Pos.Line, Code: "syntax", Text: e.Msg})
	}
	return out, nil
}

// Command lints by running an external tool on stdin and reading findings from its output.
// Pattern needs named groups line and text, and may have code.
type Command struct {
	Argv    []string
	Pattern *regexp.Regexp
}

// Lint runs the tool and parses its output. A tool that exits non-zero with output is the normal "found errors" case.
func (c Command) Lint(ctx context.Context, _, content string) ([]Finding, error) {
	cmd := exec.CommandContext(ctx, c.Argv[0], c.Argv[1:]...)
	cmd.Stdin = strings.NewReader(content)
	out, err := cmd.CombinedOutput()
	if err != nil && len(out) == 0 {
		return nil, fmt.Errorf("lintdelta: %s: %w", c.Argv[0], err)
	}
	li, ci, ti := c.Pattern.SubexpIndex("line"), c.Pattern.SubexpIndex("code"), c.Pattern.SubexpIndex("text")
	var res []Finding
	for _, m := range c.Pattern.FindAllStringSubmatch(string(out), -1) {
		n, _ := strconv.Atoi(m[li])
		f := Finding{Line: n, Text: m[ti]}
		if ci >= 0 {
			f.Code = m[ci]
		}
		res = append(res, f)
	}
	return res, nil
}
