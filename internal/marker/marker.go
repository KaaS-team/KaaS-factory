// Package marker is the one codec for the `<!-- factory:NAME {...} -->` comment markers the runner
// writes into issue threads: queued, spend and data. It also keeps text that is not the runner's
// from carrying one.
package marker

import (
	"bytes"
	"context"
	"encoding/json"
	"regexp"
	"strings"
)

// Status opens the runner's status comment; a resume edits that comment in place.
const Status = "<!-- factory:status v1"

// Wrap returns the marker NAME carrying the compact JSON object payload.
func Wrap(name, payload string) string { return "<!-- factory:" + name + " " + payload + " -->" }

// Find returns the JSON object of every NAME marker in body, in order. It does not check the JSON.
func Find(body, name string) []string {
	re := regexp.MustCompile(`(?s)<!-- factory:` + regexp.QuoteMeta(name) + ` (\{.*?\}) -->`)
	var out []string
	for _, m := range re.FindAllStringSubmatch(body, -1) {
		out = append(out, m[1])
	}
	return out
}

// JSString quotes s as JSON.stringify does: no HTML escaping and U+2028/2029 left as they are.
func JSString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s) // a string always encodes
	out := strings.TrimSuffix(buf.String(), "\n")
	out = strings.ReplaceAll(out, "\\u2028", "\u2028")
	return strings.ReplaceAll(out, "\\u2029", "\u2029")
}

// Neutralise turns every `<!--` in s into visible text, so posted model or user text cannot carry a marker.
func Neutralise(s string) string { return strings.ReplaceAll(s, "<!--", "&lt;!--") }

type allowKey struct{}

// Allow marks ctx as carrying a body the runner built itself, whose markers a tracker must post as written.
func Allow(ctx context.Context) context.Context { return context.WithValue(ctx, allowKey{}, true) }

// Allowed reports whether ctx came from Allow.
func Allowed(ctx context.Context) bool { v, _ := ctx.Value(allowKey{}).(bool); return v }

// Data is one `<!-- factory:data {"stage":...,"json":...} -->` marker.
// JSON is the raw payload exactly as written; nil means the key was absent.
type Data struct {
	Stage string
	JSON  json.RawMessage
}

// ParseData returns the data markers found in the given comment bodies, in order.
// Text that looks like a marker but does not parse, or has no string stage, is skipped.
func ParseData(bodies ...string) []Data {
	var out []Data
	for _, body := range bodies {
		for _, obj := range Find(body, "data") {
			var p struct {
				Stage *string         `json:"stage"`
				JSON  json.RawMessage `json:"json"`
			}
			if json.Unmarshal([]byte(obj), &p) != nil || p.Stage == nil {
				continue
			}
			out = append(out, Data{Stage: *p.Stage, JSON: p.JSON})
		}
	}
	return out
}

// EncodeData appends a data marker to body, byte for byte what the TS withDataMarker
// writes: two newlines, then the compact {"stage":...,"json":...} object. A nil data
// omits the json key, as JSON.stringify does for undefined.
func EncodeData(body, stage string, data json.RawMessage) string {
	obj := `{"stage":` + JSString(stage)
	if data != nil {
		var c bytes.Buffer
		if json.Compact(&c, data) != nil {
			c.Reset()
			c.WriteString("null")
		}
		obj += `,"json":` + c.String()
	}
	return body + "\n\n" + Wrap("data", obj+"}")
}

// Latest returns the payload of the last marker for stage.
func Latest(markers []Data, stage string) (json.RawMessage, bool) {
	for i := len(markers) - 1; i >= 0; i-- {
		if markers[i].Stage == stage {
			return markers[i].JSON, true
		}
	}
	return nil, false
}
