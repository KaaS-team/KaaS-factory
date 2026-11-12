package eval

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

type scriptModel struct {
	replies []string
	cost    float64
	i       int
}

func (m *scriptModel) Next(_ context.Context, _ []Message) (Reply, error) {
	t := m.replies[min(m.i, len(m.replies)-1)]
	m.i++
	return Reply{Text: t, Usage: api.Usage{InputTokens: 10, OutputTokens: 5, CostUSD: m.cost}}, nil
}

type scriptShell struct {
	out  string
	code int
	ran  []string
}

func (s *scriptShell) Run(_ context.Context, c string) (string, int, error) {
	s.ran = append(s.ran, c)
	return s.out, s.code, nil
}

const goodBlock = "thinking\n```bash\nls\n```\n"

// Control arm: the prompt stays under 200 tokens (estimated at four characters each).
func TestBarePromptUnder200Tokens(t *testing.T) {
	if n := len(BarePrompt) / 4; n >= 200 {
		t.Fatalf("control prompt is about %d tokens", n)
	}
	if !strings.Contains(BarePrompt, SubmitSentinel) {
		t.Fatal("prompt does not name the submission sentinel")
	}
}

// Control arm: every limit and the sentinel end the run with the recorded exit_status.
func TestRunBareExitStatus(t *testing.T) {
	cases := []struct {
		name    string
		model   *scriptModel
		shell   *scriptShell
		lim     BareLimits
		status  string
		steps   int
		malform int
		sub     string
	}{
		{"submitted", &scriptModel{replies: []string{goodBlock}}, &scriptShell{out: SubmitSentinel + "\ndiff here\n"}, BareLimits{Steps: 5}, ExitSubmitted, 1, 0, "diff here\n"},
		{"sentinel with nonzero exit is not a submission", &scriptModel{replies: []string{goodBlock}}, &scriptShell{out: SubmitSentinel + "\n", code: 1}, BareLimits{Steps: 2}, ExitLimitsExceeded, 2, 0, ""},
		{"step limit", &scriptModel{replies: []string{goodBlock}}, &scriptShell{out: "ok"}, BareLimits{Steps: 3}, ExitLimitsExceeded, 3, 0, ""},
		{"cost limit", &scriptModel{replies: []string{goodBlock}, cost: 0.6}, &scriptShell{out: "ok"}, BareLimits{CostUSD: 1}, ExitLimitsExceeded, 2, 0, ""},
		{"wall limit", &scriptModel{replies: []string{goodBlock}}, &scriptShell{out: "ok"}, BareLimits{Wall: time.Nanosecond}, ExitTimeExceeded, 0, 0, ""},
		{"repeated format error", &scriptModel{replies: []string{"no block"}}, &scriptShell{}, BareLimits{Steps: 9, FormatErrors: 3}, ExitRepeatedFormatError, 3, 3, ""},
		{"format error resets after a good step", &scriptModel{replies: []string{"no block", goodBlock, "no block", goodBlock, "no block", goodBlock}}, &scriptShell{out: "ok"}, BareLimits{Steps: 6, FormatErrors: 2}, ExitLimitsExceeded, 6, 3, ""},
		{"two blocks is malformed", &scriptModel{replies: []string{goodBlock + goodBlock}}, &scriptShell{}, BareLimits{Steps: 9, FormatErrors: 1}, ExitRepeatedFormatError, 1, 1, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var saved int
			r, err := RunBare(context.Background(), c.model, c.shell, "task", c.lim, func([]Message) { saved++ })
			if err != nil {
				t.Fatal(err)
			}
			if r.ExitStatus != c.status || r.Steps != c.steps || r.Malformed != c.malform || r.Submission != c.sub {
				t.Fatalf("got status %s steps %d malformed %d sub %q", r.ExitStatus, r.Steps, r.Malformed, r.Submission)
			}
			if last := r.Messages[len(r.Messages)-1]; last.Role != "exit" || last.Content != c.status {
				t.Fatalf("no exit message: %+v", last)
			}
			if saved == 0 {
				t.Fatal("history never saved")
			}
		})
	}
}

// Control arm: history is saved after every step, and long output keeps head and tail.
func TestRunBareSavesEveryStepAndClips(t *testing.T) {
	var lens []int
	sh := &scriptShell{out: strings.Repeat("a", 100) + strings.Repeat("z", 100)}
	_, err := RunBare(context.Background(), &scriptModel{replies: []string{goodBlock}}, sh, "task", BareLimits{Steps: 2, MaxObsChars: 40}, func(m []Message) { lens = append(lens, len(m)) })
	if err != nil {
		t.Fatal(err)
	}
	if len(lens) != 3 || lens[0] != 4 || lens[1] != 6 || lens[2] != 7 {
		t.Fatalf("saved history lengths %v", lens)
	}
	got := clip(sh.out, 40)
	if !strings.HasPrefix(got, strings.Repeat("a", 20)) || !strings.HasSuffix(got, strings.Repeat("z", 20)) || !strings.Contains(got, "narrow the command") {
		t.Fatalf("clip lost head, tail or hint: %q", got)
	}
}
