// Ported from OpenHands/software-agent-sdk@10be259 openhands-sdk/openhands/sdk/conversation/secret_registry.py

package egress

import (
	"regexp"
	"slices"
	"strings"
)

// Masker hides secret values in text that arrives in pieces. A per-chunk
// replace cannot see a value split across chunks, so Feed holds back the
// shortest tail that could still grow into one: the longest value minus one
// byte. Use one Masker per output stream; it is not safe for concurrent use.
type Masker struct {
	pattern *regexp.Regexp
	maxLen  int
	held    string
}

// NewMasker returns a Masker for values. Empty values are ignored; with none
// left, Feed and MaskString pass text through unchanged.
func NewMasker(values []string) *Masker {
	vs := slices.DeleteFunc(slices.Clone(values), func(v string) bool { return v == "" })
	if len(vs) == 0 {
		return &Masker{}
	}
	// Longest first so a shorter value cannot mask half of a longer one.
	slices.SortFunc(vs, func(a, b string) int { return len(b) - len(a) })
	quoted := make([]string, len(vs))
	for i, v := range vs {
		quoted[i] = regexp.QuoteMeta(v)
	}
	return &Masker{pattern: regexp.MustCompile(strings.Join(quoted, "|")), maxLen: len(vs[0])}
}

// Feed returns the masked text that is safe to release now.
func (m *Masker) Feed(text string) string {
	if m.pattern == nil {
		return text
	}
	m.held += text
	return m.release(max(len(m.held)-m.maxLen+1, 0))
}

// Flush returns what is still held back. Call it once, when no more input is coming.
func (m *Masker) Flush() string {
	if m.pattern == nil {
		return ""
	}
	return m.release(len(m.held))
}

// MaskString masks text that arrives whole, with no state.
func (m *Masker) MaskString(text string) string {
	if m.pattern == nil {
		return text
	}
	return m.pattern.ReplaceAllLiteralString(text, redacted)
}

func (m *Masker) release(cut int) string {
	var out strings.Builder
	pos, end := 0, cut
	for _, loc := range m.pattern.FindAllStringIndex(m.held, -1) {
		// A match that starts before the cut is already maximal: the cut leaves
		// maxLen-1 bytes of lookahead behind it.
		if loc[0] >= cut {
			break
		}
		out.WriteString(m.held[pos:loc[0]])
		out.WriteString(redacted)
		pos = loc[1]
		end = max(end, loc[1])
	}
	out.WriteString(m.held[pos:end])
	m.held = m.held[end:]
	return out.String()
}
