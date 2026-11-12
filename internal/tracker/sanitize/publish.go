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
	bidiControls  = regexp.MustCompile("[\u202A-\u202E\u2066-\u2069]")
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

// homoglyphs maps Cyrillic and Greek lookalikes to Latin (Unicode TR39 confusables).
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
	s = bidiControls.ReplaceAllString(s, "")
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

func isAllowedTag(name string) bool {
	switch name {
	case "abbr", "b", "blockquote", "br", "code", "del", "details", "em", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "i",
		"img", "ins", "kbd", "li", "mark", "ol", "p", "pre", "s", "span", "strong", "sub", "summary", "sup", "table",
		"tbody", "td", "th", "thead", "tr", "ul":
		return true
	}
	return false
}

var (
	tagNameRe   = regexp.MustCompile(`^/?\s*([A-Za-z][A-Za-z0-9]*)([\s/]|$)`)
	autolinkRe  = regexp.MustCompile(`^https://[\w.-]+(?::\d+)?(/[^\s<>|]*)?(?:\|[^<>]*)?$`)
	badAttrName = regexp.MustCompile(`(?i)^(?:on\w+|style$|title$|data-)`)
)

// convertXMLTags rewrites every tag outside a small allowlist as "(tag)" and strips event, style,
// title and data attributes from the allowed ones. A tag with an unclosed quote is always converted.
func convertXMLTags(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] != '<' || i+1 >= len(s) {
			b.WriteByte(s[i])
			continue
		}
		first := s[i+1]
		if first == '/' && i+2 < len(s) {
			first = s[i+2]
		}
		if (first < 'A' || first > 'Z') && (first < 'a' || first > 'z') && first != '!' {
			b.WriteByte(s[i])
			continue
		}
		if gt := strings.IndexByte(s[i:], '>'); gt > 0 && autolinkRe.MatchString(s[i+1:i+gt]) {
			b.WriteString(s[i : i+gt+1])
			i += gt
			continue
		}
		end, malformed := tagEnd(s, i)
		if end < 0 {
			b.WriteByte(s[i])
			continue
		}
		content := s[i+1 : end]
		m := tagNameRe.FindStringSubmatch(content)
		if !malformed && m != nil && isAllowedTag(strings.ToLower(m[1])) {
			b.WriteString("<" + stripBadAttrs(content) + ">")
		} else {
			b.WriteString("(" + strings.NewReplacer("<", "&lt;", ">", "&gt;").Replace(content) + ")")
		}
		i = end
	}
	return b.String()
}

// tagEnd returns the index of the '>' closing the tag at i, honouring quotes. If a quote never
// closes it falls back to the first '>' and reports the tag as malformed.
func tagEnd(s string, i int) (int, bool) {
	var q byte
	for j := i + 1; j < len(s); j++ {
		switch {
		case q != 0:
			if s[j] == q {
				q = 0
			}
		case s[j] == '"' || s[j] == '\'':
			q = s[j]
		case s[j] == '>':
			return j, false
		}
	}
	if gt := strings.IndexByte(s[i:], '>'); gt > 0 {
		return i + gt, true
	}
	return -1, false
}

func stripBadAttrs(tag string) string {
	var out strings.Builder
	p := 0
	for p < len(tag) {
		start := p
		for p < len(tag) && isSpace(tag[p]) {
			p++
		}
		ns := p
		for p < len(tag) && !strings.ContainsRune("\t\n\r\f /=>\"'`<", rune(tag[p])) {
			p++
		}
		if p == ns {
			if p < len(tag) {
				p++
			}
			out.WriteString(tag[start:p])
			continue
		}
		name := tag[ns:p]
		vs := p
		for vs < len(tag) && isSpace(tag[vs]) {
			vs++
		}
		if vs < len(tag) && tag[vs] == '=' {
			vs++
			for vs < len(tag) && isSpace(tag[vs]) {
				vs++
			}
			if vs < len(tag) && (tag[vs] == '"' || tag[vs] == '\'') {
				if c := strings.IndexByte(tag[vs+1:], tag[vs]); c >= 0 {
					p = vs + 1 + c + 1
				} else {
					p = len(tag)
				}
			} else {
				p = vs
				for p < len(tag) && !isSpace(tag[p]) {
					p++
				}
			}
		}
		if badAttrName.MatchString(name) && ns > 0 {
			continue
		}
		out.WriteString(tag[start:p])
	}
	return out.String()
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' }

// codeSpan returns a wrapper that renders text inert, using a delimiter no longer than any run in s.
func codeSpan(s string) func(text, before, after string) string {
	used := map[int]bool{}
	for _, r := range regexp.MustCompile("`+").FindAllString(s, -1) {
		used[len(r)] = true
	}
	n := 1
	for used[n] {
		n++
	}
	if n > 16 {
		esc := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", `"`, "&quot;", "'", "&#39;")
		return func(text, _, _ string) string { return "<code>" + esc.Replace(text) + "</code>" }
	}
	d := strings.Repeat("`", n)
	return func(text, before, after string) string {
		l, r := "", ""
		if strings.HasSuffix(before, "`") {
			l = " "
		}
		if strings.HasPrefix(after, "`") {
			r = " "
		}
		return l + d + text + d + r
	}
}

func neutralizeMentions(s string) string {
	wrap := codeSpan(s)
	return inNonCode(s, func(seg, rb, ra string) string {
		return replaceIdx(mentionRe, seg, func(m []int) string {
			prefix := seg[m[2]:m[3]]
			before := prefix
			if prefix == "" && m[0] == 0 {
				before = rb
			}
			after := ra
			if m[1] < len(seg) {
				after = seg[m[1] : m[1]+1]
			}
			return prefix + wrap("@"+seg[m[4]:m[5]], before, after)
		})
	})
}

func neutralizeBotTriggers(s string, keep int) string {
	wrap := codeSpan(s)
	count := 0
	return inNonCode(s, func(seg, rb, ra string) string {
		return replaceIdx(botTriggerRe, seg, func(m []int) string {
			count++
			if count <= keep {
				return seg[m[0]:m[1]]
			}
			before, after := rb, ra
			if m[0] > 0 {
				before = seg[m[0]-1 : m[0]]
			}
			if m[1] < len(seg) {
				after = seg[m[1] : m[1]+1]
			}
			return wrap(seg[m[2]:m[3]]+" #"+seg[m[4]:m[5]], before, after)
		})
	})
}

var templateEscaper = strings.NewReplacer("{{", `\{\{`, "<%=", `\<%=`, "${", `\$\{`, "{#", `\{\#`, "{%", `\{\%`)

func neutralizeTemplates(s string) string { return templateEscaper.Replace(s) }

// replaceIdx replaces each match of re in s with fn(submatch indexes).
func replaceIdx(re *regexp.Regexp, s string, fn func([]int) string) string {
	var b strings.Builder
	last := 0
	for _, m := range re.FindAllStringSubmatchIndex(s, -1) {
		b.WriteString(s[last:m[0]])
		b.WriteString(fn(m))
		last = m[1]
	}
	b.WriteString(s[last:])
	return b.String()
}

// fencedRanges returns [start,end) byte ranges of fenced code blocks (3+ backticks or tildes).
func fencedRanges(s string) [][2]int {
	var out [][2]int
	pos, start, flen := 0, -1, 0
	var fch byte
	lines := strings.Split(s, "\n")
	for i, line := range lines {
		end := pos + len(line)
		if i < len(lines)-1 {
			end++
		}
		if start < 0 {
			if m := fenceOpenRe.FindStringSubmatch(line); m != nil && (m[1][0] != '`' || !strings.Contains(m[2], "`")) {
				start, fch, flen = pos, m[1][0], len(m[1])
			}
		} else if t := strings.TrimRight(strings.TrimLeft(line, " "), " \t\r"); len(line)-len(strings.TrimLeft(line, " ")) <= 3 && len(t) >= flen && strings.Trim(t, string(fch)) == "" {
			out = append(out, [2]int{start, end})
			start = -1
		}
		pos = end
	}
	if start >= 0 {
		out = append(out, [2]int{start, len(s)})
	}
	return out
}

// inNonCode applies fn to the parts of s outside fenced blocks and inline code spans. fn also gets
// the byte before and after the part, so a replacement can avoid fusing with a neighbouring backtick.
func inNonCode(s string, fn func(seg, before, after string) string) string {
	var b strings.Builder
	pos := 0
	at := func(i int) string {
		if i < 0 || i >= len(s) {
			return ""
		}
		return s[i : i+1]
	}
	for _, r := range fencedRanges(s) {
		if pos < r[0] {
			b.WriteString(outsideInline(s[pos:r[0]], at(pos-1), at(r[0]), fn))
		}
		b.WriteString(s[r[0]:r[1]])
		pos = r[1]
	}
	if pos < len(s) {
		b.WriteString(outsideInline(s[pos:], at(pos-1), "", fn))
	}
	return b.String()
}

func outsideInline(t, outerBefore, outerAfter string, fn func(string, string, string) string) string {
	var b strings.Builder
	textStart := 0
	i := 0
	for i < len(t) {
		if t[i] != '`' {
			i++
			continue
		}
		open := i
		for i < len(t) && t[i] == '`' {
			i++
		}
		n := i - open
		closeAt := -1
		for j := i; j < len(t); {
			if t[j] != '`' {
				j++
				continue
			}
			k := j
			for j < len(t) && t[j] == '`' {
				j++
			}
			if j-k == n {
				closeAt = k
				break
			}
		}
		if closeAt < 0 {
			continue
		}
		if textStart < open {
			before := outerBefore
			if textStart > 0 {
				before = t[textStart-1 : textStart]
			}
			b.WriteString(fn(t[textStart:open], before, t[open:open+1]))
		}
		b.WriteString(t[open : closeAt+n])
		textStart = closeAt + n
		i = textStart
	}
	if textStart < len(t) {
		before := outerBefore
		if textStart > 0 {
			before = t[textStart-1 : textStart]
		}
		b.WriteString(fn(t[textStart:], before, outerAfter))
	}
	return b.String()
}
