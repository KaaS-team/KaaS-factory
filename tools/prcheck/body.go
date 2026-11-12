// Ported from scripts/check-pr-body.ts at ts-final
package main

import (
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const templatePath = ".github/pull_request_template.md"

var (
	headingRe  = regexp.MustCompile(`(?m)^## (.+)$`)
	sectionSep = regexp.MustCompile(`(?m)^## `)
	commentRe  = regexp.MustCompile(`(?s)<!--.*?-->`)
	closesRe   = regexp.MustCompile(`(?m)^Closes #?\s*$`)
	sessionRe  = regexp.MustCompile(`claude\.ai/code|Claude-Session:`)
	runDetails = regexp.MustCompile(`run-details comment`)
	notWord    = regexp.MustCompile(`[^\p{L}\p{N}\s]`)
	holder     = regexp.MustCompile(`^(pending|tbd|todo|na)(\s|$)`)
	holderWord = regexp.MustCompile(`^(pass|passed|ok|none)$`)
	fenceOrNum = regexp.MustCompile("```|\\d")
)

func headings(text string) []string {
	var out []string
	for _, m := range headingRe.FindAllStringSubmatch(text, -1) {
		out = append(out, strings.TrimSpace(m[1]))
	}
	return out
}

// sections maps each "## name" heading of a body to its text with HTML comments removed.
func sections(body string) map[string]string {
	out := map[string]string{}
	parts := sectionSep.Split(body, -1)
	for _, part := range parts[1:] {
		name, text, _ := strings.Cut(part, "\n")
		out[strings.TrimSpace(name)] = strings.TrimSpace(commentRe.ReplaceAllString(text, ""))
	}
	return out
}

// bodyProblems lists what is wrong with a PR body against the template's sections.
func bodyProblems(body, template string) []string {
	found := sections(body)
	var out []string
	if sessionRe.MatchString(body) {
		out = append(out, "the body links a Claude session")
	}
	_, hasChanged := found["What changed"]
	_, hasAcceptance := found["Acceptance"]
	if hasChanged && hasAcceptance && runDetails.MatchString(body) {
		return out
	}
	for _, name := range headings(template) {
		text, ok := found[name]
		if !ok {
			out = append(out, `missing section "`+name+`"`)
			continue
		}
		if loc := closesRe.FindStringIndex(text); loc != nil {
			text = text[:loc[0]] + text[loc[1]:]
		}
		if strings.TrimSpace(text) == "" {
			out = append(out, `section "`+name+`" is empty`)
		}
	}
	verdict := strings.TrimSpace(notWord.ReplaceAllString(strings.ToLower(found["Verify verdict"]), ""))
	if holder.MatchString(verdict) || holderWord.MatchString(verdict) {
		out = append(out, `section "Verify verdict" is a placeholder`)
	}
	if gate := strings.TrimSpace(found["Gate evidence"]); gate != "" && !fenceOrNum.MatchString(gate) {
		out = append(out, `section "Gate evidence" has no output`)
	}
	return out
}

// runBody lints PR_BODY (or the file named by --file) against the template under dir.
func runBody(dir string, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	body := getenv("PR_BODY")
	for i, a := range args {
		if a != "--file" {
			continue
		}
		if i+1 >= len(args) || args[i+1] == "" {
			sayln(stderr, "check-pr-body: --file needs a path")
			return 1
		}
		b, err := os.ReadFile(args[i+1])
		if err != nil {
			sayln(stderr, "check-pr-body:", err)
			return 2
		}
		body = string(b)
	}
	tpl, err := os.ReadFile(filepath.Join(dir, templatePath))
	if err != nil {
		sayln(stderr, "check-pr-body:", err)
		return 2
	}
	if found := bodyProblems(body, string(tpl)); len(found) > 0 {
		sayf(stderr, "check-pr-body: the PR body does not follow %s\n- %s\n", templatePath, strings.Join(found, "\n- "))
		return 1
	}
	sayln(stdout, "check-pr-body: ok")
	return 0
}
