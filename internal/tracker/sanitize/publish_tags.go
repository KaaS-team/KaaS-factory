// Ported from github/gh-aw@741ff0c actions/setup/js/sanitize_content_core.cjs
//
// MIT License, Copyright GitHub, Inc. Part of the publication slices in publish.go.

package sanitize

import (
	"regexp"
	"strings"
)

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
