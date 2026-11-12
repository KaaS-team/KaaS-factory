// Ported from anthropics/claude-code-action@8a29bc6 src/github/utils/sanitizer.ts
//
// MIT License, Copyright (c) 2025 Anthropic, PBC. Go port: RE2 has no lookbehind, so the AWS key
// boundary rule is checked in code.

// Package sanitize cleans text on its way into an agent prompt (Prompt) and on its way out to a
// tracker or channel (Publication).
package sanitize

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	htmlComment    = regexp.MustCompile(`<!--[\s\S]*?-->`)
	zeroWidth      = regexp.MustCompile("[\u200B\u200C\u200D\uFEFF]")
	controlChars   = regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F\x{7F}-\x{9F}]`)
	bidiChars      = regexp.MustCompile("[\u202A-\u202E\u2066-\u2069]")
	imgAlt         = regexp.MustCompile(`!\[[^\]]*\]\(`)
	imgRefAlt      = regexp.MustCompile(`!\[[^\]]*\](\[[^\]]*\])`)
	linkTitleDQ    = regexp.MustCompile(`(\[[^\]]*\]\([^)]+)\s+"[^"]*"`)
	linkTitleSQ    = regexp.MustCompile(`(\[[^\]]*\]\([^)]+)\s+'[^']*'`)
	numEntityDec   = regexp.MustCompile(`&#(\d+);`)
	numEntityHex   = regexp.MustCompile(`&#[xX]([0-9a-fA-F]+);`)
	ghToken        = regexp.MustCompile(`(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{11,221})\b`)
	anthropicKey   = regexp.MustCompile(`sk-ant-[A-Za-z0-9_-]{20,}`)
	awsKey         = regexp.MustCompile(`(?:AKIA|ASIA)[A-Z0-9]{16}\b`)
	awsEscapeTail  = regexp.MustCompile(`\\(?:[nrtbf"\\/]|u[0-9a-fA-F]{4})$`)
	awsAnsiTail    = regexp.MustCompile(`\[[0-9;]*m$`)
	slackToken     = regexp.MustCompile(`xox[abpsr]-[A-Za-z0-9-]{10,}`)
	jwtToken       = regexp.MustCompile(`eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b`)
	hiddenAttrExpr = hiddenAttrRegexes()
)

func hiddenAttrRegexes() []*regexp.Regexp {
	names := []string{`alt`, `title`, `aria-label`, `data-[a-zA-Z0-9-]+`, `placeholder`}
	var out []*regexp.Regexp
	for _, n := range names {
		for _, v := range []string{`"[^"]*"`, `'[^']*'`, `[^\s>]+`} {
			out = append(out, regexp.MustCompile(`(?i)\s`+n+`\s*=\s*`+v))
		}
	}
	return out
}

// Prompt removes hidden-instruction channels (comments, invisible and bidi characters, image alt
// text, link titles, tag attributes, numeric entities) and redacts credentials from issue, comment
// and review text before it reaches a prompt.
func Prompt(s string) string {
	s = htmlComment.ReplaceAllString(s, "")
	s = zeroWidth.ReplaceAllString(s, "")
	s = controlChars.ReplaceAllString(s, "")
	s = strings.ReplaceAll(s, "\u00AD", "")
	s = bidiChars.ReplaceAllString(s, "")
	s = imgAlt.ReplaceAllString(s, "![](")
	s = imgRefAlt.ReplaceAllString(s, "![]${1}")
	s = linkTitleDQ.ReplaceAllString(s, "${1}")
	s = linkTitleSQ.ReplaceAllString(s, "${1}")
	for _, re := range hiddenAttrExpr {
		s = re.ReplaceAllString(s, "")
	}
	s = numEntityDec.ReplaceAllStringFunc(s, func(m string) string { return asciiEntity(m[2:len(m)-1], 10) })
	s = numEntityHex.ReplaceAllStringFunc(s, func(m string) string { return asciiEntity(m[3:len(m)-1], 16) })
	return RedactSecrets(s)
}

func asciiEntity(digits string, base int) string {
	n, err := strconv.ParseInt(digits, base, 32)
	if err != nil || n < 32 || n > 126 {
		return ""
	}
	return string(rune(n))
}

// RedactSecrets replaces GitHub, Anthropic, AWS, Slack and JWT credentials with a [REDACTED_*] tag.
func RedactSecrets(s string) string {
	s = ghToken.ReplaceAllString(s, "[REDACTED_GITHUB_TOKEN]")
	s = anthropicKey.ReplaceAllString(s, "[REDACTED_ANTHROPIC_KEY]")
	s = redactAWS(s)
	s = slackToken.ReplaceAllString(s, "[REDACTED_SLACK_TOKEN]")
	return jwtToken.ReplaceAllString(s, "[REDACTED_JWT]")
}

// redactAWS keeps upstream's boundary: a word break, a JSON escape or an ANSI colour code before the key.
func redactAWS(s string) string {
	var b strings.Builder
	last := 0
	for _, m := range awsKey.FindAllStringIndex(s, -1) {
		head := s[:m[0]]
		if m[0] > 0 && isWordByte(head[len(head)-1]) && !awsEscapeTail.MatchString(head) && !awsAnsiTail.MatchString(head) {
			continue
		}
		b.WriteString(s[last:m[0]])
		b.WriteString("[REDACTED_AWS_KEY_ID]")
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

func isWordByte(c byte) bool {
	return c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z'
}
