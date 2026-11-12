package replay

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const recording = `[
 {"role":"user","content":[{"kind":"text","text":"fix it"}]},
 {"role":"assistant","content":[{"kind":"text","text":"done in 1.5s"}],"tokenUsage":{"inputTokens":3,"outputTokens":4}},
 {"role":"user","content":[{"kind":"image","mimeType":"image/png","data":"AAEC"}]},
 {"role":"assistant","content":[{"kind":"text","text":"seen"}]}
]`

type countingLive struct {
	calls int
	reply Message
}

func (c *countingLive) Send(context.Context, []Message) (Message, error) {
	c.calls++
	return c.reply, nil
}

func text(role Role, s string) Message {
	return Message{Role: role, Content: []Block{{Kind: "text", Text: s}}}
}

func decoded(t *testing.T) []Message {
	t.Helper()
	ms, err := Decode([]byte(recording))
	if err != nil {
		t.Fatal(err)
	}
	return ms
}

// A recorded fixture replays with zero live calls.
func TestReplayMakesNoProviderCalls(t *testing.T) {
	live := &countingLive{}
	dir := t.TempDir()
	path := filepath.Join(dir, "rec.json")
	if err := os.WriteFile(path, []byte(recording), 0o600); err != nil {
		t.Fatal(err)
	}
	s, _, err := Open(path, false, live)
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	r1, err := s.Send(ctx, []Message{text(RoleUser, "fix it")})
	if err != nil {
		t.Fatal(err)
	}
	if r1.Usage.OutputTokens != 4 || r1.Content[0].Text != "done in 1.5s" {
		t.Fatalf("reply = %+v", r1)
	}
	ms := decoded(t)
	if _, err := s.Send(ctx, ms[:3]); err != nil {
		t.Fatal(err)
	}
	if live.calls != 0 {
		t.Fatalf("live calls = %d, want 0", live.calls)
	}
}

func TestReplayIgnoresUnstableText(t *testing.T) {
	r := NewReplayer(decoded(t))
	h := []Message{text(RoleUser, "fix it")}
	if _, err := r.Send(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	h = append(h, text(RoleAssistant, "done in 9.9s"))
	h = append(h, decoded(t)[2])
	if _, err := r.Send(context.Background(), h); err != nil {
		t.Fatalf("timing difference must not diverge: %v", err)
	}
}

func TestReplayDivergence(t *testing.T) {
	media := decoded(t)[2]
	otherMedia := media
	otherMedia.Content = []Block{{Kind: "image", MIMEType: "image/png", Data: []byte("SECRETBYTES")}}
	cases := []struct {
		name    string
		history []Message
		wantIn  []string
		notIn   []string
	}{
		{"text differs at index 1", []Message{text(RoleUser, "fix it"), text(RoleAssistant, "other")},
			[]string{"diverges at index 1", "other", "done in"}, nil},
		{"role differs at index 0", []Message{text(RoleAssistant, "fix it")},
			[]string{"diverges at index 0"}, nil},
		{"media differs at index 2", []Message{text(RoleUser, "fix it"), decoded(t)[1], otherMedia},
			[]string{"diverges at index 2", "(media mismatch)", "[media data omitted]"}, []string{"SECRETBYTES", "AAEC"}},
		{"text differs next to media", []Message{text(RoleUser, "fix it"), decoded(t)[1],
			{Role: RoleUser, Content: []Block{{Kind: "image", MIMEType: "image/png", Data: []byte{0, 1, 2}}, {Kind: "text", Text: "extra"}}}},
			[]string{"diverges at index 2"}, []string{"SECRETBYTES"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := NewReplayer(decoded(t)).Send(context.Background(), c.history)
			var d *DivergenceError
			if !errors.As(err, &d) {
				t.Fatalf("err = %v, want DivergenceError", err)
			}
			msg := err.Error()
			for _, w := range c.wantIn {
				if !strings.Contains(msg, w) {
					t.Errorf("error missing %q:\n%s", w, msg)
				}
			}
			for _, n := range c.notIn {
				if strings.Contains(msg, n) {
					t.Errorf("error leaks %q:\n%s", n, msg)
				}
			}
		})
	}
}

func TestReplayExhausted(t *testing.T) {
	_, err := NewReplayer(decoded(t)).Send(context.Background(), decoded(t))
	if err == nil || !strings.Contains(err.Error(), "no more messages") {
		t.Fatalf("err = %v", err)
	}
}

func TestReplaySystemPromptTrim(t *testing.T) {
	sys := text(RoleSystem, "default prompt")
	r := NewReplayer(decoded(t))
	if _, err := r.Send(context.Background(), []Message{sys, text(RoleUser, "fix it")}); err != nil {
		t.Fatalf("synthesized system prompt must be dropped: %v", err)
	}
	own := append([]Message{text(RoleSystem, "own prompt")}, decoded(t)...)
	r = NewReplayer(own)
	if _, err := r.Send(context.Background(), []Message{text(RoleSystem, "own prompt"), text(RoleUser, "fix it")}); err != nil {
		t.Fatalf("recording's own system prompt must be kept: %v", err)
	}
}

func TestDecodeRejects(t *testing.T) {
	cases := []struct{ name, in string }{
		{"not json", `{`},
		{"unknown kind", `[{"role":"user","content":[{"kind":"bogus"}]}]`},
		{"bad base64", `[{"role":"user","content":[{"kind":"image","data":"!!"}]}]`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if _, err := Decode([]byte(c.in)); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

// Live runs only on re-record, and the recording then replays with zero calls.
func TestRerecordCallsLiveOnceThenReplays(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rec.json")
	live := &countingLive{reply: text(RoleAssistant, "hi")}
	s, save, err := Open(path, true, live)
	if err != nil {
		t.Fatal(err)
	}
	h := []Message{text(RoleUser, "hello")}
	if _, err := s.Send(context.Background(), h); err != nil {
		t.Fatal(err)
	}
	if live.calls != 1 {
		t.Fatalf("live calls = %d, want 1", live.calls)
	}
	if err := save(); err != nil {
		t.Fatal(err)
	}
	s2, _, err := Open(path, false, live)
	if err != nil {
		t.Fatal(err)
	}
	got, err := s2.Send(context.Background(), h)
	if err != nil || got.Content[0].Text != "hi" {
		t.Fatalf("replay = %+v, %v", got, err)
	}
	if live.calls != 1 {
		t.Fatalf("replay called live: %d", live.calls)
	}
}

func TestOpenReplayMissingFile(t *testing.T) {
	if _, _, err := Open(filepath.Join(t.TempDir(), "none.json"), false, nil); err == nil {
		t.Fatal("want error for missing recording")
	}
}

func TestRerecordFromEnv(t *testing.T) {
	cases := []struct {
		val  string
		want bool
	}{{"", false}, {"0", false}, {"1", true}, {"true", true}}
	for _, c := range cases {
		if got := RerecordFromEnv(func(string) string { return c.val }); got != c.want {
			t.Errorf("%q: got %v", c.val, got)
		}
	}
}
