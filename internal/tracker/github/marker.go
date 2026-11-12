package github

import (
	"bytes"
	"encoding/json"
	"regexp"
	"strings"
	"time"
)

// Comment is one issue comment as the codec and trust rules see it.
type Comment struct {
	ID        int64
	Author    string
	Body      string
	CreatedAt time.Time
}

// StatusMarker opens the runner's status comment; a resume edits that comment in place.
const StatusMarker = "<!-- factory:status v1"

// DataMarker is one `<!-- factory:data {"stage":...,"json":...} -->` marker.
// JSON is the raw payload exactly as written; nil means the key was absent.
type DataMarker struct {
	Stage string
	JSON  json.RawMessage
}

var (
	dataMarkerRE = regexp.MustCompile(`(?s)<!-- factory:data (\{.*?\}) -->`)
)

// ParseData returns the data markers found in the given comment bodies, in order.
// Text that looks like a marker but does not parse, or has no string stage, is skipped.
func ParseData(bodies ...string) []DataMarker {
	var out []DataMarker
	for _, body := range bodies {
		for _, m := range dataMarkerRE.FindAllStringSubmatch(body, -1) {
			var p struct {
				Stage *string         `json:"stage"`
				JSON  json.RawMessage `json:"json"`
			}
			if json.Unmarshal([]byte(m[1]), &p) != nil || p.Stage == nil {
				continue
			}
			out = append(out, DataMarker{Stage: *p.Stage, JSON: p.JSON})
		}
	}
	return out
}

// EncodeData appends a data marker to body, byte for byte what the TS withDataMarker
// writes: two newlines, then the compact {"stage":...,"json":...} object. A nil data
// omits the json key, as JSON.stringify does for undefined.
func EncodeData(body, stage string, data json.RawMessage) string {
	var b strings.Builder
	b.WriteString(body)
	b.WriteString("\n\n<!-- factory:data {\"stage\":")
	b.WriteString(jsString(stage))
	if data != nil {
		var c bytes.Buffer
		if err := json.Compact(&c, data); err != nil {
			c.Reset()
			c.WriteString("null")
		}
		b.WriteString(",\"json\":")
		b.Write(c.Bytes())
	}
	b.WriteString("} -->")
	return b.String()
}

// jsString quotes s as JSON.stringify does: no HTML escaping and U+2028/2029 left as they are.
func jsString(s string) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	out := strings.TrimSuffix(buf.String(), "\n")
	out = strings.ReplaceAll(out, `\u2028`, "\u2028")
	return strings.ReplaceAll(out, `\u2029`, "\u2029")
}

// Latest returns the payload of the last marker for stage.
func Latest(markers []DataMarker, stage string) (json.RawMessage, bool) {
	for i := len(markers) - 1; i >= 0; i-- {
		if markers[i].Stage == stage {
			return markers[i].JSON, true
		}
	}
	return nil, false
}

// FindStatus returns the latest comment that carries the status marker.
func FindStatus(comments []Comment) (Comment, bool) {
	for i := len(comments) - 1; i >= 0; i-- {
		if strings.Contains(comments[i].Body, StatusMarker) {
			return comments[i], true
		}
	}
	return Comment{}, false
}
