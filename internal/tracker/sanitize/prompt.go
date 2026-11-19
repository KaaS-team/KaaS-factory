// Ported from anthropics/claude-code-action@8a29bc6 src/github/utils/sanitizer.ts
//
// MIT License, Copyright (c) 2025 Anthropic, PBC. Go port. The credential patterns moved to
// internal/redact.

// Package sanitize cleans text on its way into an agent prompt (Prompt) and on its way out to a
// tracker or channel (Publication).
package sanitize

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/KaaS-team/factory/internal/redact"
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

// RedactSecrets replaces credentials with a [REDACTED_*] tag. It is redact.Secrets.
func RedactSecrets(s string) string { return redact.Secrets(s) }
