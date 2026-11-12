// Package vendorkit is what the Linear and Jira adapters share: an HTTP client with bounded
// retries, and the marker codec that carries <!-- factory --> markers through trackers that strip
// HTML comments. Wire formats match src/adapters/trackers/kit.ts.
package vendorkit

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"
	"unicode"
)

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
	sealed := seal(jsString([]any{field, norm(visible), body}))
	data := jsString(struct {
		V string `json:"v"`
		B string `json:"b"`
	}{sealed, body})
	return visible + "\n\n" + footer + base64.RawURLEncoding.EncodeToString([]byte(data))
}
