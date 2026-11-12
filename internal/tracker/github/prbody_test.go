package github_test

import (
	"strings"
	"testing"

	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

func TestRenderWhatChanged(t *testing.T) {
	cases := []struct {
		name  string
		goal  string
		files []string
		proof *gh.Proof
		want  string
	}{
		{"bites", " Add the lease. ", []string{"a.go", "b.go"}, &gh.Proof{Status: "bites", Tests: []string{"TestA"}, Reverted: []string{"a.go"}},
			"## What changed\n\nAdd the lease.\n\n- Files: `a.go`, `b.go`\n- Fails without it: `TestA`, red with `a.go` reverted"},
		{"bites, nothing reverted named", "g", []string{"a.go"}, &gh.Proof{Status: "bites", Tests: []string{"TestA", "TestB"}},
			"## What changed\n\ng\n\n- Files: `a.go`\n- Fails without it: `TestA`, `TestB`, red with the change reverted"},
		{"no files", "g", nil, &gh.Proof{Status: "bites", Tests: []string{"T"}, Reverted: []string{"x"}},
			"## What changed\n\ng\n\n- Files: none in the diff\n- Fails without it: `T`, red with `x` reverted"},
		{"proof did not bite", "g", []string{"a"}, &gh.Proof{Status: "none"},
			"## What changed\n\ng\n\n- Files: `a`\n- Fails without it: no test shown (proof none)"},
		{"bites but no tests", "g", []string{"a"}, &gh.Proof{Status: "bites"},
			"## What changed\n\ng\n\n- Files: `a`\n- Fails without it: no test shown (proof bites)"},
		{"no proof", "g", []string{"a"}, nil,
			"## What changed\n\ng\n\n- Files: `a`\n- Fails without it: no test shown (proof did not run)"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gh.RenderWhatChanged(tc.goal, tc.files, tc.proof); got != tc.want {
				t.Fatalf("got:\n%s\nwant:\n%s", got, tc.want)
			}
		})
	}
}

func TestRenderPRBodyAssembly(t *testing.T) {
	parts := gh.PRParts{
		WhatChanged: "## What changed\n\ng",
		Acceptance:  "## Acceptance\n\n- [x] one",
		Closes:      "Closes #4",
		RunDetails:  gh.IssueRef(12),
	}
	want := strings.Join([]string{
		"## What changed\n\ng",
		"the body",
		"## Acceptance\n\n- [x] one",
		"Closes #4",
		"The receipt is in the run-details comment on #12.",
	}, "\n\n")
	if got := gh.RenderPRBody("the body", parts); got != want {
		t.Fatalf("got:\n%s\nwant:\n%s", got, want)
	}
	if got := gh.RenderPRBody("only body", gh.PRParts{}); got != "only body" {
		t.Fatalf("empty parts changed the body: %q", got)
	}
}

// #210: the PR footer and every part name no model, no token count, no cost, no claude.ai link.
func TestRenderPRBodyLeaksNothing(t *testing.T) {
	leaks := []string{
		"Built with claude-opus-4-5 today",
		"Model: claude-sonnet-5-5",
		"Sonnet 4.5 wrote this",
		"ran on Haiku 4",
		"gpt-5 helped",
		"used 12,345 tokens",
		"tokens: 9000",
		"1.2M tokens",
		"cost: $3.20",
		"Cost was 4 USD",
		"cost_usd 0.5",
		"spent $12",
		"total $0.42",
		"https://claude.ai/code/session_abc",
		"see claude.ai/code",
		"Claude-Session: https://x",
		"Co-Authored-By: Claude <noreply@anthropic.com>",
		"Generated with [Claude Code](https://claude.com/claude-code)",
		"key sk-ant-api03-abcdef",
	}
	forbidden := []string{"claude-", "opus", "sonnet", "haiku", "gpt-", "token", "$", "claude.ai", "claude-session", "co-authored", "generated with", "usd", "cost", "spent", "sk-ant"}
	for _, leak := range leaks {
		inputs := map[string]gh.PRParts{
			"body":        {},
			"whatChanged": {WhatChanged: gh.RenderWhatChanged(leak, []string{"a.go"}, nil)},
			"acceptance":  {Acceptance: "## Acceptance\n\n- " + leak},
			"closes":      {Closes: leak},
			"runDetails":  {RunDetails: leak},
			"proof":       {WhatChanged: gh.RenderWhatChanged("g", []string{leak}, &gh.Proof{Status: "bites", Tests: []string{leak}, Reverted: []string{leak}})},
		}
		for name, parts := range inputs {
			body := leak
			if name != "body" {
				body = "plain body"
			}
			out := strings.ToLower(gh.RenderPRBody(body, parts))
			for _, f := range forbidden {
				if strings.Contains(out, f) {
					t.Errorf("input %q in %s: output still has %q:\n%s", leak, name, f, out)
				}
			}
		}
	}
}

func TestRenderPRBodyKeepsOrdinaryText(t *testing.T) {
	body := "Add a tokenizer for the config file.\nThe `.claude/skills` path is untouched.\nPrice list stays as is."
	if got := gh.RenderPRBody(body, gh.PRParts{}); got != body {
		t.Fatalf("ordinary text changed:\n%s", got)
	}
}

func TestIssueRef(t *testing.T) {
	if gh.IssueRef(7) != "#7" {
		t.Fatal("IssueRef(7)")
	}
}
