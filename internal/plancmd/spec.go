package plancmd

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/dispatch/local"
)

// specBudgetUSD caps one spec-drafting run of the operator's agent.
const specBudgetUSD = 2.0

const specPrompt = `Draft a spec for this goal. Read the repository first, read-only, and change nothing.

Goal: %s

Reply with the spec text only, in exactly this shape:

1. A short paragraph saying what is built and why.
2. Acceptance criteria, one per line, numbered in order: "AC-1: ...", "AC-2: ...".
3. Then the tickets. Each opens with a line "--- ticket <key>: <title>", followed by:
   <!-- factory:planned v1 -->
   Deps: none  (or the keys it waits for, like "Deps: T1, T2")
   ## Why
   ## Acceptance   (lines "- AC-n: ...")
   ## Files        (lines "- ` + "`path`" + `")
Tickets that touch the same file must depend on each other.`

const specRetry = `

Your previous answer was rejected for these reasons:
%s

Your previous answer was:
%s

Answer again with the whole corrected spec, in the same shape.`

// LocalSpec returns a SpecFunc that drafts the spec with the operator's own agent binary, run once
// in plan mode with read-only tools in repoDir. An invalid spec is retried once with the validation
// errors, then returned as an error. The argv comes from the local dispatcher's builder.
func LocalSpec(bin string, repoDir string) SpecFunc {
	return func(ctx context.Context, goal string) (string, error) {
		prompt := fmt.Sprintf(specPrompt, goal)
		var problems []string
		for attempt := 0; attempt < 2; attempt++ {
			text, err := runAgent(ctx, bin, repoDir, prompt)
			if err != nil {
				return "", err
			}
			_, problems, err = build(ctx, text, "01-goal")
			if err != nil {
				return "", err
			}
			if len(problems) == 0 {
				return text, nil
			}
			prompt = fmt.Sprintf(specPrompt, goal) + fmt.Sprintf(specRetry, "- "+strings.Join(problems, "\n- "), text)
		}
		return "", fmt.Errorf("the drafted spec is invalid after one retry:\n- %s", strings.Join(problems, "\n- "))
	}
}

var providerPrefixes = []string{"ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "GEMINI_", "MISTRAL_", "COHERE_"}

// agentEnv is the parent environment without provider keys; sessions run under the operator's login.
func agentEnv(parent []string, extra map[string]string) []string {
	var out []string
	for _, kv := range parent {
		name, _, _ := strings.Cut(kv, "=")
		up := strings.ToUpper(name)
		drop := up == "GOOGLE_API_KEY" || up == "CURSOR_API_KEY"
		for _, p := range providerPrefixes {
			drop = drop || strings.HasPrefix(up, p)
		}
		if _, over := extra[name]; !drop && !over {
			out = append(out, kv)
		}
	}
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}

// runAgent runs one read-only plan-mode agent turn and returns its final text.
func runAgent(ctx context.Context, bin, dir, prompt string) (string, error) {
	argv, err := local.ClaudeArgv(local.ClaudeInput{Stage: "plan", Issue: "plan", MaxBudgetUSD: specBudgetUSD, Prompt: prompt})
	if err != nil {
		return "", err
	}
	// The builder's plan stage lists write tools; a spec draft only reads.
	for i := 0; i+1 < len(argv); i++ {
		switch argv[i] {
		case "--tools":
			argv[i+1] = "Read,Grep,Glob"
		case "--permission-mode":
			argv[i+1] = "plan"
		}
	}
	cmd := exec.CommandContext(ctx, bin, argv[1:]...)
	cmd.Dir = dir
	cmd.Env = agentEnv(os.Environ(), local.ClaudePreset.Env)
	cmd.WaitDelay = 2 * time.Second
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	text, found := finalText(out)
	if err != nil && !found {
		return "", fmt.Errorf("running %s: %w: %s", bin, err, strings.TrimSpace(stderr.String()))
	}
	if !found {
		return "", errors.New("the agent printed no final text")
	}
	return text, nil
}

// finalText reads stream-json and returns the result line's text, else the last assistant text.
func finalText(out []byte) (string, bool) {
	var last string
	var found bool
	sc := bufio.NewScanner(bytes.NewReader(out))
	sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
	for sc.Scan() {
		var l struct {
			Type    string `json:"type"`
			Result  string `json:"result"`
			Message struct {
				Content []struct {
					Type string `json:"type"`
					Text string `json:"text"`
				} `json:"content"`
			} `json:"message"`
		}
		if json.Unmarshal(sc.Bytes(), &l) != nil {
			continue
		}
		switch l.Type {
		case "result":
			if l.Result != "" {
				return l.Result, true
			}
		case "assistant":
			var b strings.Builder
			for _, c := range l.Message.Content {
				if c.Type == "text" {
					b.WriteString(c.Text)
				}
			}
			if b.Len() > 0 {
				last, found = b.String(), true
			}
		}
	}
	return last, found
}
