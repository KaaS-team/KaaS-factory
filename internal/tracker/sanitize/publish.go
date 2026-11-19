// Ported from github/gh-aw@741ff0c actions/setup/js/sanitize_content_core.cjs
//
// MIT License, Copyright GitHub, Inc. Go port of the publication slices: canonical text, XML and
// template neutralization, mentions, bot triggers and truncation. The URL slice is in url.go.
// Left out: command and cross-repo reference neutralization, NFC/NFKC normalization, code-region
// balancing, the redaction log and every GitHub Actions environment read.

package sanitize

import (
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Options tunes Publication. The zero value allows no bot trigger phrase and the default limits.
type Options struct {
	// AllowedDomains lists hosts whose https URLs survive; a name also allows its subdomains and
	// "*.name" allows subdomains only. Nil means DefaultAllowedDomains.
	AllowedDomains []string
	// MaxLength caps the output in bytes; 0 means 524288.
	MaxLength int
	// MaxLines caps the output in lines; 0 means 65000.
	MaxLines int
	// MaxBotTriggers is how many "fixes #N" style phrases stay live; the rest go into code spans.
	MaxBotTriggers int
}

// DefaultAllowedDomains are the hosts Publication keeps by default.
var DefaultAllowedDomains = []string{"github.com", "github.io", "githubusercontent.com", "githubassets.com", "github.dev", "codespaces.new"}

// DefaultOptions returns the upstream defaults: GitHub hosts only and ten bot trigger phrases.
func DefaultOptions() Options { return Options{MaxBotTriggers: 10} }

const (
	defaultMaxLength = 524288
	defaultMaxLines  = 65000
)

var (
	ansiCSI       = regexp.MustCompile(`\x1b\[[0-?]*[ -/]*[@-~]`)
	ctrlNoNL      = regexp.MustCompile(`[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]`)
	invisibles    = regexp.MustCompile("[\u00AD\u034F\u200B-\u200F\u2060-\u2064\uFEFF\\x{E0000}-\\x{E007F}]")
	bidiControls  = regexp.MustCompile("[\u061C\u202A-\u202E\u2066-\u2069]")
	namedEntities = regexp.MustCompile(`(?i)&(?:amp;)?(commat|gt|lt|amp|shy|zwnj|zwj|lrm|rlm|ZeroWidthSpace|NoBreak|af|ApplyFunction|it|InvisibleTimes|ic|InvisibleComma|ip|InvisiblePlus);`)
	numEntity     = regexp.MustCompile(`&(?:amp;)?#(?:[xX]([0-9a-fA-F]+)|(\d+));`)
	mentionRe     = regexp.MustCompile(`(^|[^A-Za-z0-9])@([A-Za-z0-9](?:[A-Za-z0-9_-]{0,37}[A-Za-z0-9])?(?:/[A-Za-z0-9._-]+)?)`)
	botTriggerRe  = regexp.MustCompile(`(?i)\b(fixes?|closes?|resolves?)\s+#(\w+)`)
	fenceOpenRe   = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})(.*)$")
	titleInlineRe = regexp.MustCompile(`(\[[^\]]*)\]\(([^()\s]+)\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\))\)`)
	titleRefRe    = regexp.MustCompile(`(?m)^(\s{0,3}\[[^\]]+\]:\s+\S+)\s+(?:"[^"]*"|'[^']*'|\([^)]*\))[ \t]*$`)
)

var entityChars = map[string]string{
	"commat": "@", "gt": ">", "lt": "<", "amp": "&", "shy": "\u00AD", "zwnj": "\u200C", "zwj": "\u200D",
	"lrm": "\u200E", "rlm": "\u200F", "zerowidthspace": "\u200B", "nobreak": "\u2060", "af": "\u2061",
	"applyfunction": "\u2061", "it": "\u2062", "invisibletimes": "\u2062", "ic": "\u2063",
	"invisiblecomma": "\u2063", "ip": "\u2064", "invisibleplus": "\u2064",
}

// homoglyphs maps Cyrillic and Greek lookalikes to Latin (Unicode TR39 confusables), for fold only.
var homoglyphs = strings.NewReplacer(
	"\u0410", "A", "\u0412", "B", "\u0415", "E", "\u041A", "K", "\u041C", "M", "\u041D", "H", "\u041E", "O", "\u0420", "P", "\u0421", "C", "\u0422", "T", "\u0425", "X", "\u0405", "S", "\u0406", "I",
	"\u0430", "a", "\u0435", "e", "\u043E", "o", "\u0440", "p", "\u0441", "c", "\u0445", "x", "\u0443", "y", "\u0456", "i", "\u0455", "s", "\u0458", "j",
	"\u0391", "A", "\u0392", "B", "\u0395", "E", "\u0396", "Z", "\u0397", "H", "\u0399", "I", "\u039A", "K", "\u039C", "M", "\u039D", "N", "\u039F", "O", "\u03A1", "P", "\u03A4", "T", "\u03A5", "Y", "\u03A7", "X",
	"\u03BF", "o", "\u03BD", "v", "\u03B9", "i",
)

// Publication makes text safe to write to a tracker or channel: it hardens Unicode, strips
// comments and unsafe markup, redacts non-allowlisted URLs, neutralizes mentions, excess bot
// trigger phrases and template delimiters, and truncates.
func Publication(s string, o Options) string {
	if s == "" {
		return ""
	}
	if o.MaxLength <= 0 {
		o.MaxLength = defaultMaxLength
	}
	if o.MaxLines <= 0 {
		o.MaxLines = defaultMaxLines
	}
	if o.AllowedDomains == nil {
		o.AllowedDomains = DefaultAllowedDomains
	}
	s = truncate(s, o.MaxLength, o.MaxLines)
	s, ok := canonicalize(s)
	if !ok {
		return "[content removed: nested encodings]"
	}
	s = inNonCode(s, func(seg, _, _ string) string { return removeXMLComments(seg) })
	s = inNonCode(s, func(seg, _, _ string) string { return neutralizeLinkTitles(seg) })
	s = inNonCode(s, func(seg, _, _ string) string { return convertXMLTags(seg) })
	s = sanitizeURLs(s, o.AllowedDomains)
	s = truncate(s, o.MaxLength, o.MaxLines)
	s = neutralizeMentions(s)
	s = neutralizeBotTriggers(s, o.MaxBotTriggers)
	s = inNonCode(s, func(seg, _, _ string) string { return neutralizeTemplates(seg) })
	return strings.TrimSpace(s)
}

// canonicalize rewrites until stable, so nested encodings cannot hide a payload; false means it never settled.
func canonicalize(s string) (string, bool) {
	for range 16 {
		n := harden(s)
		n = ansiCSI.ReplaceAllString(n, "")
		n = ctrlNoNL.ReplaceAllString(n, "")
		if n == s {
			return n, true
		}
		s = n
	}
	return "", false
}

func harden(s string) string {
	s = namedEntities.ReplaceAllStringFunc(s, func(m string) string {
		name := strings.ToLower(strings.TrimSuffix(strings.TrimPrefix(strings.TrimPrefix(strings.ToLower(m), "&amp;"), "&"), ";"))
		return entityChars[name]
	})
	s = numEntity.ReplaceAllStringFunc(s, func(m string) string {
		sub := numEntity.FindStringSubmatch(m)
		n, err := parseCode(sub[1], sub[2])
		if err != nil || n > 0x10FFFF {
			return m
		}
		return string(rune(n))
	})
	s = invisibles.ReplaceAllString(s, "")
	return bidiControls.ReplaceAllString(s, "")
}

// fold maps fullwidth forms and Cyrillic or Greek lookalikes to ASCII, one rune for one rune. It is
// only a detection view for mentions and bot triggers; text that is not matched is never folded.
func fold(s string) string {
	s = strings.Map(func(r rune) rune {
		if r >= 0xFF01 && r <= 0xFF5E {
			return r - 0xFEE0
		}
		return r
	}, s)
	return homoglyphs.Replace(s)
}

func parseCode(hex, dec string) (int64, error) {
	if hex != "" {
		return strconv.ParseInt(hex, 16, 64)
	}
	return strconv.ParseInt(dec, 10, 64)
}

// truncate cuts to maxLines first, then to maxLen bytes, on a rune boundary, and says so.
func truncate(s string, maxLen, maxLines int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > maxLines {
		const msg = "\n[Content truncated due to line count]"
		out := strings.Join(lines[:maxLines], "\n") + msg
		if len(out) > maxLen {
			return cutRunes(out, max(maxLen-len(msg), 0)) + msg
		}
		return out
	}
	if len(s) > maxLen {
		return cutRunes(s, maxLen) + "\n[Content truncated due to length]"
	}
	return s
}

func cutRunes(s string, n int) string {
	if n >= len(s) {
		return s
	}
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// removeXMLComments drops <!-- ... --> with nesting, so <!-- <!-- --> payload --> leaves nothing.
func removeXMLComments(s string) string {
	var b strings.Builder
	depth := 0
	for i := 0; i < len(s); {
		switch {
		case strings.HasPrefix(s[i:], "<!--"):
			depth++
			i += 4
		case depth > 0 && strings.HasPrefix(s[i:], "--!>"):
			depth--
			i += 4
		case depth > 0 && strings.HasPrefix(s[i:], "-->"):
			depth--
			i += 3
		default:
			if depth == 0 {
				b.WriteByte(s[i])
			}
			i++
		}
	}
	return b.String()
}

// neutralizeLinkTitles moves an inline link title into the visible text and drops reference titles.
func neutralizeLinkTitles(s string) string {
	s = titleInlineRe.ReplaceAllStringFunc(s, func(m string) string {
		g := titleInlineRe.FindStringSubmatch(m)
		return g[1] + " (" + g[3] + g[4] + g[5] + ")](" + g[2] + ")"
	})
	return titleRefRe.ReplaceAllString(s, "${1}")
}
