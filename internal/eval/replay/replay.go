// Ported from dagger/dagger@835b0ef806b277fb216735a180d1a542c2937024 core/llm_recording.go

// Package replay runs eval fixtures from a recorded conversation with no model
// calls. A recording is replayed by default; a live provider is called only when
// the recording is made again.
package replay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Role is who sent a message.
type Role string

// Roles a recorded message can have.
const (
	RoleSystem    Role = "system"
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Block is one piece of message content. Image, audio and document blocks
// carry Data; tool results nest further blocks in Content.
type Block struct {
	Kind      string  `json:"kind"`
	Text      string  `json:"text,omitempty"`
	CallID    string  `json:"callId,omitempty"`
	ToolName  string  `json:"toolName,omitempty"`
	Arguments string  `json:"arguments,omitempty"`
	Errored   bool    `json:"errored,omitempty"`
	Signature string  `json:"signature,omitempty"`
	MIMEType  string  `json:"mimeType,omitempty"`
	Data      []byte  `json:"data,omitempty"`
	Content   []Block `json:"content,omitempty"`
}

// Usage is the token usage a recorded reply carried.
type Usage struct {
	InputTokens       int64 `json:"inputTokens"`
	OutputTokens      int64 `json:"outputTokens"`
	CachedTokenReads  int64 `json:"cachedTokenReads"`
	CachedTokenWrites int64 `json:"cachedTokenWrites"`
	TotalTokens       int64 `json:"totalTokens"`
}

// Message is one turn of a recorded conversation.
type Message struct {
	Role    Role    `json:"role"`
	Content []Block `json:"content"`
	Usage   Usage   `json:"tokenUsage"`
}

// Sender returns the reply to a conversation history.
type Sender interface {
	Send(ctx context.Context, history []Message) (Message, error)
}

var kinds = map[string]bool{
	"text": true, "thinking": true, "tool_call": true, "tool_result": true,
	"image": true, "audio": true, "document": true,
}

func isMedia(kind string) bool { return kind == "image" || kind == "audio" || kind == "document" }

func validate(blocks []Block) error {
	for _, b := range blocks {
		if !kinds[b.Kind] {
			return fmt.Errorf("unknown content kind %q", b.Kind)
		}
		if err := validate(b.Content); err != nil {
			return err
		}
	}
	return nil
}

// Decode parses a recording (a JSON array of messages) and checks every block kind.
func Decode(data []byte) ([]Message, error) {
	var ms []Message
	if err := json.Unmarshal(data, &ms); err != nil {
		return nil, err
	}
	for i, m := range ms {
		if err := validate(m.Content); err != nil {
			return nil, fmt.Errorf("message %d: %w", i, err)
		}
	}
	return ms, nil
}

// textContent is the text the replayer compares: text blocks and tool calls.
func textContent(m Message) string {
	var sb strings.Builder
	var walk func([]Block)
	walk = func(bs []Block) {
		for _, b := range bs {
			switch b.Kind {
			case "text":
				sb.WriteString(b.Text)
			case "tool_call":
				sb.WriteString(b.ToolName + " " + b.Arguments)
			}
			walk(b.Content)
		}
	}
	walk(m.Content)
	return sb.String()
}

type mediaBlock struct {
	pos, mime string
	data      []byte
}

// media lists media blocks with their position and enclosing kinds, so nested
// tool-result media cannot match otherwise identical top-level media.
func media(m Message) []mediaBlock {
	var out []mediaBlock
	var walk func([]Block, string)
	walk = func(bs []Block, parent string) {
		for i, b := range bs {
			pos := fmt.Sprintf("%s/%d:%s", parent, i, b.Kind)
			if isMedia(b.Kind) {
				out = append(out, mediaBlock{pos, b.MIMEType, b.Data})
			}
			walk(b.Content, pos)
		}
	}
	walk(m.Content, "")
	return out
}

func sameMedia(a, b []mediaBlock) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].pos != b[i].pos || a[i].mime != b[i].mime || !bytes.Equal(a[i].data, b[i].data) {
			return false
		}
	}
	return true
}

// render prints a message one line per block with media bytes replaced by a
// size and short digest, so a diff never shows media content.
func render(m Message) []string {
	lines := []string{"role: " + string(m.Role)}
	var walk func([]Block, string)
	walk = func(bs []Block, indent string) {
		for _, b := range bs {
			line := indent + b.Kind
			switch {
			case isMedia(b.Kind):
				sum := sha256.Sum256(b.Data)
				line += fmt.Sprintf(" %s [media data omitted] %d bytes sha256:%s", b.MIMEType, len(b.Data), hex.EncodeToString(sum[:6]))
			case b.Kind == "tool_call":
				line += fmt.Sprintf(" %s(%s) id=%s", b.ToolName, b.Arguments, b.CallID)
			default:
				line += " " + b.Text
			}
			lines = append(lines, line)
			walk(b.Content, indent+"  ")
		}
	}
	walk(m.Content, "  ")
	return lines
}

func diff(want, got Message) string {
	a, b := render(want), render(got)
	var sb strings.Builder
	for i := 0; i < max(len(a), len(b)); i++ {
		switch {
		case i < len(a) && i < len(b) && a[i] == b[i]:
			sb.WriteString("  " + a[i] + "\n")
		default:
			if i < len(a) {
				sb.WriteString("- " + a[i] + "\n")
			}
			if i < len(b) {
				sb.WriteString("+ " + b[i] + "\n")
			}
		}
	}
	return sb.String()
}

// DivergenceError says the history given to the replayer differs from the
// recording. Index is the first differing message; Diff never holds media bytes.
type DivergenceError struct {
	Index         int
	MediaMismatch bool
	Diff          string
}

func (e *DivergenceError) Error() string {
	note := ""
	if e.MediaMismatch {
		note = " (media mismatch)"
	}
	return fmt.Sprintf("message history diverges at index %d%s:\n%s", e.Index, note, e.Diff)
}

// Replayer answers from a recording and never calls a model.
type Replayer struct{ messages []Message }

// NewReplayer returns a Replayer over a decoded recording.
func NewReplayer(messages []Message) *Replayer { return &Replayer{messages: messages} }

// Send checks history against the recording, ignoring unstable text (digests,
// sizes, timings, ports), and returns the next recorded message.
func (r *Replayer) Send(ctx context.Context, history []Message) (Message, error) {
	if err := ctx.Err(); err != nil {
		return Message{}, err
	}
	// A synthesized default system prompt is never in a recording. Keep the
	// leading system message only when it is the recording's own.
	if len(history) > 0 && history[0].Role == RoleSystem {
		if len(r.messages) == 0 || r.messages[0].Role != RoleSystem ||
			Stabilize(textContent(r.messages[0])) != Stabilize(textContent(history[0])) {
			history = history[1:]
		}
	}
	if len(history) >= len(r.messages) {
		return Message{}, errors.New("no more messages")
	}
	for i, got := range history {
		want := r.messages[i]
		mediaBad := !sameMedia(media(want), media(got))
		if mediaBad || got.Role != want.Role || Stabilize(textContent(got)) != Stabilize(textContent(want)) {
			return Message{}, &DivergenceError{Index: i, MediaMismatch: mediaBad, Diff: diff(want, got)}
		}
	}
	return r.messages[len(history)], nil
}

// Recorder forwards to a live Sender and keeps the longest conversation it saw.
type Recorder struct {
	live Sender
	conv []Message
}

// Send calls the live sender and remembers the history and its reply.
func (r *Recorder) Send(ctx context.Context, history []Message) (Message, error) {
	reply, err := r.live.Send(ctx, history)
	if err != nil {
		return Message{}, err
	}
	if c := append(append([]Message(nil), history...), reply); len(c) > len(r.conv) {
		r.conv = c
	}
	return reply, nil
}

// RerecordFromEnv reports whether FACTORY_EVAL_RERECORD asks for a live run.
func RerecordFromEnv(getenv func(string) string) bool {
	v := getenv("FACTORY_EVAL_RERECORD")
	return v != "" && v != "0" && v != "false"
}

// Open returns the Sender for the recording at path and a save function. By
// default it replays the file and live is never used. With rerecord it calls
// live, and save writes the conversation to path.
func Open(path string, rerecord bool, live Sender) (Sender, func() error, error) {
	if !rerecord {
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, nil, err
		}
		ms, err := Decode(data)
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		return NewReplayer(ms), func() error { return nil }, nil
	}
	if live == nil {
		return nil, nil, errors.New("re-record needs a live sender")
	}
	rec := &Recorder{live: live}
	save := func() error {
		data, err := json.MarshalIndent(rec.conv, "", " ")
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return os.WriteFile(path, append(data, '\n'), 0o644)
	}
	return rec, save, nil
}
