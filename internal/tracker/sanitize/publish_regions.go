// Ported from github/gh-aw@741ff0c actions/setup/js/sanitize_content_core.cjs
//
// MIT License, Copyright GitHub, Inc. Part of the publication slices in publish.go.

package sanitize

import (
	"regexp"
	"strings"
	"unicode/utf8"
)

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
		return replaceFolded(mentionRe, seg, func(seg string, m []int, orig func(a, b int) string) string {
			prefix := seg[m[2]:m[3]]
			before := prefix
			if prefix == "" && m[0] == 0 {
				before = rb
			}
			after := ra
			if m[1] < len(seg) {
				after = seg[m[1] : m[1]+1]
			}
			return orig(m[2], m[3]) + wrap("@"+seg[m[4]:m[5]], before, after)
		})
	})
}

func neutralizeBotTriggers(s string, keep int) string {
	wrap := codeSpan(s)
	count := 0
	return inNonCode(s, func(seg, rb, ra string) string {
		return replaceFolded(botTriggerRe, seg, func(seg string, m []int, orig func(a, b int) string) string {
			count++
			if count <= keep {
				return orig(m[0], m[1])
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

// replaceFolded matches re against fold(s) and replaces each match with fn(folded, submatch indexes,
// orig), where orig(a, b) returns the original text for folded bytes a to b. Text outside a match
// comes back as it was, so non-Latin letters and fullwidth punctuation survive.
func replaceFolded(re *regexp.Regexp, s string, fn func(folded string, m []int, orig func(a, b int) string) string) string {
	f := fold(s)
	// at[i] is the byte offset in s of byte i of f; only rune starts (and len(f)) are set, which is
	// where a match can begin or end.
	at := make([]int, len(f)+1)
	fi := 0
	for si, r := range s {
		at[fi] = si
		fi += utf8.RuneLen(foldRune(r))
	}
	at[len(f)] = len(s)
	orig := func(a, b int) string { return s[at[a]:at[b]] }
	var b strings.Builder
	last := 0
	for _, m := range re.FindAllStringSubmatchIndex(f, -1) {
		b.WriteString(orig(last, m[0]))
		b.WriteString(fn(f, m, orig))
		last = m[1]
	}
	b.WriteString(orig(last, len(f)))
	return b.String()
}

func foldRune(r rune) rune { return []rune(fold(string(r)))[0] }

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
