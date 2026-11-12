// Ported from SWE-agent/mini-swe-agent@04d809c src/minisweagent/agents/default.py

package eval

import (
	"context"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Exit statuses of the bare-bash control arm, the four mini-swe-agent uses.
const (
	ExitSubmitted           = "Submitted"
	ExitLimitsExceeded      = "LimitsExceeded"
	ExitTimeExceeded        = "TimeExceeded"
	ExitRepeatedFormatError = "RepeatedFormatError"
)

// SubmitSentinel is the first output line of a successful command that ends the control run.
const SubmitSentinel = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"

// BarePrompt is the system prompt of the control arm: one bash tool, no repo rules.
const BarePrompt = "You are a software engineer working in a Linux shell. Each turn, reply with a short thought and exactly one fenced ```bash block. " +
	"Every command runs in a fresh subshell, so nothing persists between turns except files. " +
	"Change non-test files to do what the task says, then run the tests. " +
	"To finish, run a command whose first output line is " + SubmitSentinel + ", for example: echo " + SubmitSentinel + " && git diff."

// BareLimits bound one control run. A zero field means no limit for that axis.
type BareLimits struct {
	Steps        int
	CostUSD      float64
	Wall         time.Duration
	FormatErrors int // consecutive malformed replies before giving up
	MaxObsChars  int // observation cap, head and tail kept; 0 means 4000
}

// Message is one entry of the linear control history.
type Message struct {
	Role    string `json:"role"` // system, user, assistant, exit
	Content string `json:"content"`
}

// Reply is one model turn: its text and the usage it was billed.
type Reply struct {
	Text  string
	Usage api.Usage
}

// BareModel answers the whole history. Implementations bill nothing in tests.
type BareModel interface {
	Next(ctx context.Context, history []Message) (Reply, error)
}

// BareShell runs one command in a fresh subshell and returns its output and exit code.
type BareShell interface {
	Run(ctx context.Context, command string) (out string, code int, err error)
}

// BareResult is what one control run produced. Malformed counts every reply with no bash block.
type BareResult struct {
	ExitStatus string
	Submission string
	Steps      int
	Malformed  int
	Messages   []Message
	Usage      api.Usage
}

var bashBlock = regexp.MustCompile("(?s)```bash\\s*\n(.*?)```")

// RunBare drives the control loop: query, parse one bash block, run it, append the observation.
// It stops on the submission sentinel or on a limit. onStep sees the history after every step.
func RunBare(ctx context.Context, m BareModel, sh BareShell, task string, lim BareLimits, onStep func([]Message)) (BareResult, error) {
	start := time.Now()
	r := BareResult{Messages: []Message{{Role: "system", Content: BarePrompt}, {Role: "user", Content: task}}}
	maxObs := lim.MaxObsChars
	if maxObs <= 0 {
		maxObs = 4000
	}
	exit := func(status string) (BareResult, error) {
		r.ExitStatus = status
		r.Messages = append(r.Messages, Message{Role: "exit", Content: status})
		if onStep != nil {
			onStep(r.Messages)
		}
		return r, nil
	}
	consecutive := 0
	for {
		if err := ctx.Err(); err != nil {
			return r, err
		}
		if (lim.Steps > 0 && r.Steps >= lim.Steps) || (lim.CostUSD > 0 && r.Usage.CostUSD >= lim.CostUSD) {
			return exit(ExitLimitsExceeded)
		}
		if lim.Wall > 0 && time.Since(start) >= lim.Wall {
			return exit(ExitTimeExceeded)
		}
		r.Steps++
		rep, err := m.Next(ctx, r.Messages)
		if err != nil {
			return r, fmt.Errorf("control model: %w", err)
		}
		r.Usage.InputTokens += rep.Usage.InputTokens
		r.Usage.OutputTokens += rep.Usage.OutputTokens
		r.Usage.CostUSD += rep.Usage.CostUSD
		r.Messages = append(r.Messages, Message{Role: "assistant", Content: rep.Text})
		blocks := bashBlock.FindAllStringSubmatch(rep.Text, -1)
		if len(blocks) != 1 {
			r.Malformed++
			consecutive++
			r.Messages = append(r.Messages, Message{Role: "user", Content: fmt.Sprintf("Format error: found %d bash blocks, need exactly one.", len(blocks))})
			if lim.FormatErrors > 0 && consecutive >= lim.FormatErrors {
				return exit(ExitRepeatedFormatError)
			}
		} else {
			consecutive = 0
			out, code, err := sh.Run(ctx, blocks[0][1])
			if err != nil {
				return r, fmt.Errorf("control shell: %w", err)
			}
			if first, rest, _ := strings.Cut(strings.TrimLeft(out, " \t\r\n"), "\n"); code == 0 && strings.TrimSpace(first) == SubmitSentinel {
				r.Submission = rest
				return exit(ExitSubmitted)
			}
			r.Messages = append(r.Messages, Message{Role: "user", Content: fmt.Sprintf("exit code %d\n%s", code, clip(out, maxObs))})
		}
		if onStep != nil {
			onStep(r.Messages)
		}
	}
}

// clip keeps the head and tail of s within max runes and says how to narrow the command.
func clip(s string, max int) string {
	rs := []rune(s)
	if len(rs) <= max {
		return s
	}
	h := max / 2
	return string(rs[:h]) + fmt.Sprintf("\n... %d characters elided; narrow the command (grep, head, a path) ...\n", len(rs)-2*h) + string(rs[len(rs)-h:])
}

// DefaultBareLimits are the control arm limits `factory eval` uses.
var DefaultBareLimits = BareLimits{Steps: 50, CostUSD: 3, Wall: 10 * time.Minute, FormatErrors: 3}

// controlDeps runs Dispatch as the bare-bash control loop; the gate and hidden test come from inner.
type controlDeps struct {
	Deps
	model BareModel
	shell BareShell
}

func (c controlDeps) Dispatch(ctx context.Context, t api.Ticket) (Outcome, error) {
	var save func([]Message)
	if info, ok := ctx.Value(runKey{}).(runInfo); ok {
		save = info.save
	}
	start := time.Now()
	r, err := RunBare(ctx, c.model, c.shell, t.Title+"\n\n"+t.Body, DefaultBareLimits, save)
	if err != nil {
		return Outcome{}, err
	}
	return Outcome{Attempts: 1, Updates: []api.Usage{r.Usage}, Wall: time.Since(start), Malformed: r.Malformed, Output: r.Submission, ExitStatus: r.ExitStatus}, nil
}
