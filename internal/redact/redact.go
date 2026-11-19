// Ported from gitleaks/gitleaks@5f6ec56 cmd/generate/config/rules/github.go
//
// Token families follow gitleaks rules (github.go, anthropic.go, openai.go, aws.go, slack.go,
// privatekey.go). The lengths are looser than gitleaks on purpose: a redactor must over-match, a
// scanner must not. The AWS boundary rule is from anthropics/claude-code-action@8a29bc6
// src/github/utils/sanitizer.ts.
//
// MIT License, Copyright (c) 2019 Zachary Rice; Copyright (c) 2025 Anthropic, PBC.

// Package redact is the one secret redactor. The gate tail, the prompt sanitizer and the log
// printer all call it, so a token kind is covered everywhere or nowhere.
package redact

import (
	"regexp"
	"strings"
)

type rule struct {
	tag string
	re  *regexp.Regexp
}

// rules run in order, so a specific kind (sk-ant-) is matched before the general one (sk-).
var rules = []rule{
	{"GITHUB_TOKEN", regexp.MustCompile(`\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{11,})`)},
	{"ANTHROPIC_KEY", regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{16,}`)},
	{"OPENAI_KEY", regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`)},
	{"SLACK_TOKEN", regexp.MustCompile(`\b(?:xox[abeprso]|xapp)-[A-Za-z0-9-]{10,}`)},
	{"JWT", regexp.MustCompile(`\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+`)},
	{"PRIVATE_KEY", regexp.MustCompile(`-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)?`)},
}

// strictRules add shapes that are not tokens but still carry a credential. Logs use them. Prompts
// do not, because "code=" or "Bearer" in an issue is ordinary text.
var strictRules = []rule{
	{"URL_CREDENTIAL", regexp.MustCompile(`//[^\s/@:]+:[^\s/@]+@`)},
	{"BEARER", regexp.MustCompile(`(?i)\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._~-]{8,}`)},
	{"QUERY_SECRET", regexp.MustCompile(`(?i)[?&](?:token|access_token|key|api_key|secret|sig|signature|code|auth)=[^&\s#]*`)},
}

var (
	awsKey        = regexp.MustCompile(`(?:AKIA|ASIA)[A-Z0-9]{16}\b`)
	awsEscapeTail = regexp.MustCompile(`\\(?:[nrtbf"\\/]|u[0-9a-fA-F]{4})$`)
	awsAnsiTail   = regexp.MustCompile(`\[[0-9;]*m$`)
)

// Tag renders a redaction. kind is a name such as GITHUB_TOKEN.
type Tag func(kind string) string

// Secrets replaces every token with [REDACTED_<KIND>].
func Secrets(s string) string { return replace(s, rules, tagged) }

// Strict is Secrets plus URL credentials, Bearer headers and secret query parameters. Every match
// becomes the plain string "[redacted]".
func Strict(s string) string {
	return replace(s, append(append([]rule(nil), rules...), strictRules...), plain)
}

// Has reports whether s holds a token Secrets would redact.
func Has(s string) bool { return Secrets(s) != s }

func tagged(kind string) string { return "[REDACTED_" + kind + "]" }
func plain(string) string       { return "[redacted]" }

func replace(s string, rs []rule, tag Tag) string {
	for _, r := range rs {
		k := r.tag
		s = r.re.ReplaceAllStringFunc(s, func(string) string { return tag(k) })
	}
	return redactAWS(s, tag("AWS_KEY_ID"))
}

// redactAWS keeps upstream's boundary: a word break, a JSON escape or an ANSI colour code before the key.
func redactAWS(s, tag string) string {
	var b strings.Builder
	last := 0
	for _, m := range awsKey.FindAllStringIndex(s, -1) {
		head := s[:m[0]]
		if m[0] > 0 && isWordByte(head[len(head)-1]) && !awsEscapeTail.MatchString(head) && !awsAnsiTail.MatchString(head) {
			continue
		}
		b.WriteString(s[last:m[0]])
		b.WriteString(tag)
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}
