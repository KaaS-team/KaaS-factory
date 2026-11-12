// Ported from BerriAI/litellm@7553c4f litellm/router_strategy/complexity_router/stall_detector.py

// Package stall reads an agent's recent tool calls and reports whether the task looks stuck.
// It makes no model call and keeps no verdict: the same window is rescanned each time.
package stall

import (
	"bytes"
	"encoding/json"
	"sync"
)

// Message is one conversation turn in either the Anthropic Messages shape (Content holds
// tool_use and tool_result blocks) or the chat-completions shape (ToolCalls).
type Message struct {
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	ToolCalls []ToolCall      `json:"tool_calls"`
}

// ToolCall is a chat-completions tool call.
type ToolCall struct {
	Function Function `json:"function"`
}

// Function names the tool and carries its arguments as a JSON object or a JSON string.
type Function struct {
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
}

type part struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	IsError   bool            `json:"is_error"`
}

type event struct {
	sig     string
	isError bool // false where the surface reports no error status
}

// signature canonicalizes a call so the same call compares equal across both surfaces:
// string arguments are decoded when they hold JSON and map keys are sorted.
func signature(name string, raw json.RawMessage) string {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		v = nil
	}
	if s, ok := v.(string); ok {
		var inner any
		if json.Unmarshal([]byte(s), &inner) == nil {
			v = inner
		}
	}
	b, err := json.Marshal(v)
	if err != nil {
		return name + "\x00" + string(raw)
	}
	return name + "\x00" + string(b)
}

func parts(m Message) []part {
	var ps []part
	if t := bytes.TrimSpace(m.Content); len(t) > 0 && t[0] == '[' {
		_ = json.Unmarshal(t, &ps)
	}
	return ps
}

// newestFirst lists tool-call events from the newest call back, at most limit of them.
func newestFirst(msgs []Message, limit int) []event {
	errs := map[string]bool{}
	for _, m := range msgs {
		if m.Role != "user" {
			continue
		}
		for _, p := range parts(m) {
			if p.Type == "tool_result" && p.ToolUseID != "" {
				errs[p.ToolUseID] = p.IsError
			}
		}
	}
	var out []event
	for i := len(msgs) - 1; i >= 0 && len(out) < limit; i-- {
		m := msgs[i]
		if m.Role != "assistant" {
			continue
		}
		ps := parts(m)
		for j := len(ps) - 1; j >= 0 && len(out) < limit; j-- {
			if ps[j].Type == "tool_use" && ps[j].Name != "" {
				out = append(out, event{signature(ps[j].Name, ps[j].Input), errs[ps[j].ID]})
			}
		}
		for j := len(m.ToolCalls) - 1; j >= 0 && len(out) < limit; j-- {
			if f := m.ToolCalls[j].Function; f.Name != "" {
				out = append(out, event{sig: signature(f.Name, f.Arguments)})
			}
		}
	}
	return out
}

// Detect reports whether the newest tool call is still part of a stuck pattern: it repeats,
// or it errored, at least threshold times across the last window calls. Both tests are
// anchored on the newest call, so a task that repeated itself and then moved on reads as recovered.
func Detect(msgs []Message, window, threshold int) bool {
	if len(msgs) == 0 || threshold <= 0 {
		return false
	}
	recent := newestFirst(msgs, window)
	if len(recent) < threshold {
		return false
	}
	repeats, errored := 0, 0
	for _, e := range recent {
		if e.sig == recent[0].sig {
			repeats++
		}
		if e.isError {
			errored++
		}
	}
	return repeats >= threshold || (recent[0].isError && errored >= threshold)
}

// maxMessages bounds a Log: older turns cannot fall inside any sane window.
const maxMessages = 400

// Log collects the turns of one session from its stream-json lines.
type Log struct {
	mu   sync.Mutex
	msgs []Message
}

// Feed adds one stream-json line; lines that are not assistant or user turns are ignored.
func (l *Log) Feed(line []byte) {
	var v struct {
		Type    string  `json:"type"`
		Message Message `json:"message"`
	}
	if json.Unmarshal(line, &v) != nil || (v.Type != "assistant" && v.Type != "user") {
		return
	}
	if v.Message.Role == "" {
		v.Message.Role = v.Type
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.msgs = append(l.msgs, v.Message)
	if len(l.msgs) > maxMessages {
		l.msgs = append([]Message(nil), l.msgs[len(l.msgs)-maxMessages:]...)
	}
}

// Stalled runs Detect over the turns fed so far.
func (l *Log) Stalled(window, threshold int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return Detect(l.msgs, window, threshold)
}
