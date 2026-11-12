package github

import (
	"fmt"
	"regexp"
	"strings"
)

// Proof is the verify stage's test-that-bites result.
type Proof struct {
	Status   string
	Tests    []string
	Reverted []string
}

// QARoute is one route the QA step requested.
type QARoute struct {
	Path   string
	Status int
	OK     bool
}

// QA is the QA step's result.
type QA struct{ Routes []QARoute }

// Shot is a before and after screenshot pair; an empty Before is a new screen.
type Shot struct{ Name, Before, After string }

// TryIt is one command and the output a reviewer should see.
type TryIt struct{ Command, Output string }

// PRParts is what the PR body is built from beyond the pr stage's own text. Each piece is already rendered.
type PRParts struct {
	WhatChanged string
	Acceptance  string
	Tasks       string
	Closes      string
	// RunDetails names the issue holding the run-details comment (see IssueRef).
	RunDetails string
	QA         *QA
	Shots      []Shot
	TryIt      *TryIt
}

// IssueRef names a GitHub issue so the PR body links to it.
func IssueRef(n int) string { return fmt.Sprintf("#%d", n) }

// RenderWhatChanged builds the body's opening section from the goal, the diff and the proof (src/engine/pr-body.ts).
func RenderWhatChanged(goal string, files []string, proof *Proof) string {
	lines := []string{"## What changed", "", strings.TrimSpace(goal), ""}
	if len(files) > 0 {
		quoted := make([]string, len(files))
		for i, f := range files {
			quoted[i] = "`" + f + "`"
		}
		lines = append(lines, "- Files: "+strings.Join(quoted, ", "))
	} else {
		lines = append(lines, "- Files: none in the diff")
	}
	if proof != nil && proof.Status == "bites" && len(proof.Tests) > 0 {
		lines = append(lines, "- Fails without it: "+quoteAll(proof.Tests)+", red with "+orDefault(quoteAll(proof.Reverted), "the change")+" reverted")
	} else {
		status := "did not run"
		if proof != nil {
			status = proof.Status
		}
		lines = append(lines, "- Fails without it: no test shown (proof "+status+")")
	}
	return strings.Join(lines, "\n")
}

func quoteAll(xs []string) string {
	q := make([]string, len(xs))
	for i, x := range xs {
		q[i] = "`" + x + "`"
	}
	return strings.Join(q, ", ")
}

func orDefault(s, d string) string {
	if s == "" {
		return d
	}
	return s
}

func fence(text string) string {
	longest := 2
	for _, run := range regexp.MustCompile("`+").FindAllString(text, -1) {
		longest = max(longest, len(run))
	}
	return strings.Repeat("`", longest+1)
}

func qaSection(qa *QA) string {
	lines := []string{"## QA", "", "| Route | Status | Result |", "| --- | --- | --- |"}
	for _, r := range qa.Routes {
		res := "failed"
		if r.OK {
			res = "ok"
		}
		lines = append(lines, fmt.Sprintf("| `%s` | %d | %s |", r.Path, r.Status, res))
	}
	return strings.Join(lines, "\n")
}

func shotsSection(shots []Shot) string {
	cell := func(ref string) string {
		if ref == "" {
			return "_none_"
		}
		return "![](" + ref + ")"
	}
	lines := []string{"## Screenshots", "", "| Route | Before | After |", "| --- | --- | --- |"}
	for _, s := range shots {
		lines = append(lines, fmt.Sprintf("| `%s` | %s | %s |", s.Name, cell(s.Before), cell(s.After)))
	}
	return strings.Join(lines, "\n")
}

func tryItSection(t *TryIt) string {
	block := func(text string) string { f := fence(text); return f + "\n" + text + "\n" + f }
	lines := []string{"## Try it", "", block(t.Command)}
	if t.Output != "" {
		lines = append(lines, "", "Expected output:", "", block(t.Output))
	}
	return strings.Join(lines, "\n")
}

// RenderPRBody assembles the PR body: What changed, the task table, the pr
// stage's text, Acceptance, the optional QA, Screenshots and Try it sections,
// the closing line and the pointer to the run-details comment. It carries no
// footer, and Redact runs over the result so no model name, token count, cost
// or claude.ai link reaches the PR (#210).
func RenderPRBody(body string, p PRParts) string {
	if p.Tasks != "" {
		body = p.Tasks + "\n\n" + body
	}
	if p.WhatChanged != "" {
		body = p.WhatChanged + "\n\n" + body
	}
	if p.Acceptance != "" {
		body += "\n\n" + p.Acceptance
	}
	var extra []string
	if p.QA != nil {
		extra = append(extra, qaSection(p.QA))
	}
	if len(p.Shots) > 0 {
		extra = append(extra, shotsSection(p.Shots))
	}
	if p.TryIt != nil {
		extra = append(extra, tryItSection(p.TryIt))
	}
	if len(extra) > 0 {
		body += "\n\n" + strings.Join(extra, "\n\n")
	}
	if p.Closes != "" {
		body += "\n\n" + p.Closes
	}
	if p.RunDetails != "" {
		body += "\n\nThe receipt is in the run-details comment on " + p.RunDetails + "."
	}
	return Redact(body)
}

// leakRE matches operator detail that must never reach a customer: model names,
// token counts, cost, claude.ai links, attribution trailers and provider keys.
var leakRE = regexp.MustCompile(`(?i)` + strings.Join([]string{
	`\bclaude[-\s]?(opus|sonnet|haiku|fable|instant|\d)`,
	`\b(opus|sonnet|haiku|fable|gemini|gpt)[-\s]?\d`,
	`claude\.ai`,
	`claude-session:`,
	`co-authored-by:.*(claude|anthropic)`,
	`generated with.*claude`,
	`\b\d[\d,._]*\s*[km]?\s*(input |output |cache )?tokens?\b`,
	`\btokens?\b\s*[:=]\s*\d`,
	`\$\s?\d`,
	`\b\d+(\.\d+)?\s*(usd|dollars)\b`,
	`\b(cost|spend|spent)\b\s*[:=]?\s*(usd|us\$)?\s*\d`,
	`cost_usd`,
	`sk-ant-`,
}, "|"))

// Redact drops every line that carries model, token, cost, claude.ai or key detail.
func Redact(s string) string {
	lines := strings.Split(s, "\n")
	kept := lines[:0]
	for _, l := range lines {
		if !leakRE.MatchString(l) {
			kept = append(kept, l)
		}
	}
	return strings.Join(kept, "\n")
}
