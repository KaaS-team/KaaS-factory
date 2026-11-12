package jira

import (
	"encoding/json"
	"strings"
)

type node struct {
	Type    string `json:"type"`
	Text    string `json:"text"`
	Content []node `json:"content"`
}

// toADF is the minimal document for plain text: one paragraph per line.
func toADF(text string) map[string]any {
	content := []any{}
	for _, line := range strings.Split(text, "\n") {
		p := map[string]any{"type": "paragraph"}
		if line != "" {
			p["content"] = []any{map[string]any{"type": "text", "text": line}}
		}
		content = append(content, p)
	}
	return map[string]any{"type": "doc", "version": 1, "content": content}
}

// adfText flattens a description to text. A JSON string (Data Center) and null are accepted too.
func adfText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var n node
	if json.Unmarshal(raw, &n) != nil {
		return ""
	}
	return flatten(n)
}

func inline(n node) bool {
	return n.Type == "text" || n.Type == "hardBreak" || n.Type == "mention" || n.Type == "emoji"
}

func flatten(n node) string {
	switch n.Type {
	case "text":
		return n.Text
	case "hardBreak":
		return "\n"
	}
	parts := make([]string, 0, len(n.Content))
	allInline := true
	for _, c := range n.Content {
		allInline = allInline && inline(c)
		parts = append(parts, flatten(c))
	}
	if allInline {
		return strings.Join(parts, "")
	}
	return strings.Join(parts, "\n")
}
