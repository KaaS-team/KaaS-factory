package local

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Ported by hand from src/agents/presets/claude.ts and src/stage-permissions.ts
// at ts-final; the golden cases in testdata pin the output byte for byte.

const stageGuidance = "Shell rules for this stage: a command is refused if it writes a file with > or >> (>/dev/null and 2>&1 are fine), uses $(...), backticks or $?, uses brace expansion, or has cd or VAR=value at the start of the command or of any part after &&, ; or |. Commands already run in the repo root and the tool result shows the exit code. A refusal is about that one command, not Bash: rewrite it and carry on. To revert files use git restore --source=<ref> -- <files>. Tests: make test FILES=\"<files>\", make check or .factory/gates.sh; rewrite a refused one."

var stageDisallowedTools = []string{
	"ScheduleWakeup", "CronCreate", "CronDelete", "CronList", "Monitor", "RemoteTrigger",
	"PushNotification", "SendMessage", "ListAgents", "Workflow", "EnterWorktree", "ExitWorktree",
}

var baseTools = []string{"Bash", "Read", "Write", "Skill"}

var stageTools = map[string][]string{
	"triage": baseTools,
	"plan":   append(append([]string{}, baseTools...), "Agent"),
	"build":  append(append([]string{}, baseTools...), "Edit"),
	"verify": append(append([]string{}, baseTools...), "Edit", "Agent"),
	"pr":     baseTools,
	"retro":  baseTools,
}

var readOnlyBash = []string{
	"git status *", "git diff *", "git log *", "git show *", "git rev-parse *", "git worktree list",
	"cat *", "ls *", "grep *", "find *", "mkdir -p *", "echo *", "head *", "tail *", "wc *", "diff *", "pwd",
}

var buildExtra = []string{
	"Edit(**)", "Bash(git add *)", "Bash(git commit *)", "Bash(git rm *)",
	"Bash(.factory/gates.sh*)", "Bash(bash .factory/gates.sh*)",
}

var verifyExtra = []string{
	"Bash(git stash *)", "Bash(git checkout *)", "Bash(git restore *)",
	"Bash(.factory/mutate.sh *)", "Bash(bash .factory/mutate.sh *)",
}

// The stages that only classify or fill a template run on a small model at low effort.
var stageModel = map[string]struct{ model, effort string }{
	"triage": {"sonnet", "low"}, "pr": {"sonnet", "low"}, "retro": {"sonnet", "low"},
	"plan": {}, "build": {}, "verify": {},
}

// Resume forks an earlier session and tells it why the last attempt came back.
type Resume struct {
	SessionID string
	Failure   string
}

// Commands are a repo's extra allowed shell patterns per stage. Patterns
// that fail the safe-outputs allowlist are dropped, as in the TS preset.
type Commands struct {
	Read, Build, Verify []string
}

// ClaudeInput is everything the claude argv depends on.
type ClaudeInput struct {
	Stage        string
	Issue        string
	MaxBudgetUSD float64
	Prompt       string // replaces "/factory-<stage> <issue>"
	Resume       *Resume
	ContextPack  string
	MCPConfig    string
	MCPServers   []string
	Plugins      []string // project plugins to switch off for the run
	Commands     Commands
	Model        string // replaces the stage's default model
	JSONSchema   string // the schema itself, not a path
}

func bashRules(patterns []string) []string {
	out := make([]string, 0, len(patterns))
	for _, p := range patterns {
		out = append(out, "Bash("+p+")")
	}
	return out
}

func allowRules(stage, issue string, c Commands) []string {
	rules := []string{"Edit(.factory/runs/issue-" + issue + "/**)"}
	rules = append(rules, bashRules(readOnlyBash)...)
	rules = append(rules, bashRules(safeCommands(c.Read))...)
	switch stage {
	case "build":
		rules = append(rules, buildExtra...)
		rules = append(rules, bashRules(safeCommands(c.Build))...)
	case "verify":
		rules = append(rules, verifyExtra...)
		rules = append(rules, bashRules(safeCommands(c.Verify))...)
	}
	return rules
}

// jsJSON is JSON.stringify: compact and without HTML escaping.
func jsJSON(v any) string {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v) // the values here always encode
	return strings.TrimSuffix(buf.String(), "\n")
}

func settings(in ClaudeInput) string {
	allow := allowRules(in.Stage, in.Issue, in.Commands)
	for _, s := range in.MCPServers {
		allow = append(allow, "mcp__"+s)
	}
	type perms struct {
		Allow []string `json:"allow"`
	}
	out := struct {
		Permissions    perms           `json:"permissions"`
		EnabledPlugins map[string]bool `json:"enabledPlugins,omitempty"`
	}{Permissions: perms{Allow: allow}}
	if len(in.Plugins) > 0 {
		out.EnabledPlugins = map[string]bool{}
		for _, p := range in.Plugins {
			out.EnabledPlugins[p] = false
		}
	}
	return jsJSON(out)
}

// ClaudeArgv returns the full argv, binary first, that the TypeScript preset
// builds for the same inputs.
func ClaudeArgv(in ClaudeInput) ([]string, error) {
	tools, ok := stageTools[in.Stage]
	if !ok {
		return nil, fmt.Errorf("local: unknown stage %q", in.Stage)
	}
	if in.Issue == "" {
		return nil, errors.New("local: issue is required")
	}
	command := in.Prompt
	if command == "" {
		command = "/factory-" + in.Stage + " " + in.Issue
	}
	prompt := command
	argv := []string{"claude", "-p"}
	if in.Resume != nil {
		prompt = command + "\n\nThe last attempt was sent back. The tail of why:\n\n" + in.Resume.Failure
	}
	argv = append(argv, prompt)
	if in.Resume != nil && in.Resume.SessionID != "" {
		argv = append(argv, "--resume", in.Resume.SessionID, "--fork-session")
	}
	argv = append(argv,
		"--output-format", "stream-json", "--verbose",
		"--permission-mode", "dontAsk",
		"--permission-prompts", "none",
		"--setting-sources", "project,local",
	)
	if in.MCPConfig != "" {
		argv = append(argv, "--mcp-config", in.MCPConfig)
	}
	guidance := stageGuidance
	if in.ContextPack != "" {
		guidance += "\n\n" + in.ContextPack
	}
	argv = append(argv,
		"--strict-mcp-config",
		"--disallowedTools", strings.Join(stageDisallowedTools, ","),
		"--tools", strings.Join(tools, ","),
		"--settings", settings(in),
		"--append-system-prompt", guidance,
		"--max-budget-usd", strconv.FormatFloat(in.MaxBudgetUSD, 'f', -1, 64),
	)
	d := stageModel[in.Stage]
	model := d.model
	if in.Model != "" {
		model = in.Model
	}
	if model != "" {
		argv = append(argv, "--model", model)
	}
	if d.effort != "" {
		argv = append(argv, "--effort", d.effort)
	}
	if in.JSONSchema != "" {
		argv = append(argv, "--json-schema", in.JSONSchema)
	}
	return argv, nil
}
