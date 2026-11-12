// Package vendorkit is what the Linear and Jira adapters share: an HTTP client with bounded
// retries, and the marker codec that carries <!-- factory --> markers through trackers that strip
// HTML comments. Wire formats match src/adapters/trackers/kit.ts.
package vendorkit

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
)

// SpendMarker opens the hidden marker of the spend ledger comment.
const SpendMarker = "<!-- factory:spend "

const footer = "factory-data: "

// Seal keys a footer to the tracker token, so an outsider cannot forge one.
type Seal func(s string) string

// HMACSeal returns a Seal that is HMAC-SHA256 keyed by token, first 32 hex chars.
func HMACSeal(token string) Seal {
	return func(s string) string {
		m := hmac.New(sha256.New, []byte(token))
		m.Write([]byte(s))
		return hex.EncodeToString(m.Sum(nil))[:32]
	}
}

var markerRe = regexp.MustCompile(`(?s)<!--.*?-->\n?`)

// VisibleOf is the body without HTML comments, trailing space trimmed.
func VisibleOf(body string) string {
	if !strings.Contains(body, "<!--") {
		return body
	}
	return strings.TrimRight(markerRe.ReplaceAllString(body, ""), " \t\r\n")
}

// jsString marshals like JavaScript's JSON.stringify: no HTML escaping, raw U+2028 and U+2029.
func jsString(v any) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	s := strings.TrimSuffix(b.String(), "\n")
	return strings.NewReplacer(` `, " ", ` `, " ").Replace(s)
}

func norm(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

// EncodeBody keeps the original of a body with markers in a sealed last line, because the tracker
// may drop the comment. A body without markers is returned unchanged.
func EncodeBody(body string, seal Seal, field string) string {
	if !strings.Contains(body, "<!--") {
		return body
	}
	visible := VisibleOf(body)
	data := jsString(struct {
		V string `json:"v"`
		B string `json:"b"`
	}{sealOf(seal, field, visible, body), body})
	return visible + "\n\n" + footer + base64.RawURLEncoding.EncodeToString([]byte(data))
}

func sealOf(seal Seal, field, visible, body string) string {
	return seal(jsString([]any{field, norm(visible), body}))
}

// DecodeBody restores the original body from a sealed footer. It reports false when the text has no
// footer, or the seal does not hold for this field and the text above it, so a stranger's comment
// that imitates one is never taken for the runner's.
func DecodeBody(text string, seal Seal, field string) (string, bool) {
	at := strings.LastIndex(text, footer)
	if at == -1 || (at > 0 && text[at-1] != '\n') {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimSpace(text[at+len(footer):]))
	if err != nil {
		return "", false
	}
	var data struct{ V, B string }
	if json.Unmarshal(raw, &data) != nil {
		return "", false
	}
	want := sealOf(seal, field, strings.TrimRight(text[:at], " \t\r\n"), data.B)
	if subtle.ConstantTimeCompare([]byte(data.V), []byte(want)) != 1 {
		return "", false
	}
	return data.B, true
}
