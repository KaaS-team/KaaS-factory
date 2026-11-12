package local

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

type goldenCase struct {
	Name  string `json:"name"`
	Input struct {
		Stage        string  `json:"stage"`
		Issue        int     `json:"issue"`
		MaxBudgetUSD float64 `json:"maxBudgetUsd"`
		Resume       *struct {
			SessionID string `json:"sessionId"`
			Failure   string `json:"failure"`
		} `json:"resume"`
		Commands *struct {
			Read   []string `json:"read"`
			Build  []string `json:"build"`
			Verify []string `json:"verify"`
		} `json:"commands"`
		MCP         []string `json:"mcp"`
		MCPConfig   string   `json:"mcpConfig"`
		ContextPack string   `json:"contextPack"`
		Model       string   `json:"model"`
		JSONSchema  string   `json:"jsonSchema"`
	} `json:"input"`
	Argv []string `json:"argv"`
}

// The cases in testdata come from running src/agents/presets/claude.ts at ts-final
// (claudeArgs and claudeModelArgs), including the ones tests/agents.test.ts pins.
func TestClaudeArgvMatchesTypeScriptByteForByte(t *testing.T) {
	raw, err := os.ReadFile("testdata/claude_argv.json")
	if err != nil {
		t.Fatal(err)
	}
	var g struct {
		Guidance   string       `json:"guidance"`
		Disallowed []string     `json:"disallowed"`
		Cases      []goldenCase `json:"cases"`
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		t.Fatal(err)
	}
	if len(g.Cases) < 12 {
		t.Fatalf("only %d cases", len(g.Cases))
	}
	if stageGuidance != g.Guidance || !reflect.DeepEqual(stageDisallowedTools, g.Disallowed) {
		t.Fatal("guidance or disallowed tools drifted from the TS source")
	}
	for _, c := range g.Cases {
		in := ClaudeInput{
			Stage: c.Input.Stage, Issue: itoa(c.Input.Issue), MaxBudgetUSD: c.Input.MaxBudgetUSD,
			MCPServers: c.Input.MCP, MCPConfig: c.Input.MCPConfig, ContextPack: c.Input.ContextPack,
			Model: c.Input.Model, JSONSchema: c.Input.JSONSchema,
		}
		if c.Input.Resume != nil {
			in.Resume = &Resume{SessionID: c.Input.Resume.SessionID, Failure: c.Input.Resume.Failure}
		}
		if cm := c.Input.Commands; cm != nil {
			in.Commands = Commands{Read: cm.Read, Build: cm.Build, Verify: cm.Verify}
		}
		got, err := ClaudeArgv(in)
		if err != nil {
			t.Errorf("%s: %v", c.Name, err)
			continue
		}
		if !reflect.DeepEqual(got, c.Argv) {
			t.Errorf("%s:\n got %q\nwant %q", c.Name, got, c.Argv)
		}
	}
}

func TestClaudeArgvRejectsUnknownStageAndEmptyIssue(t *testing.T) {
	if _, err := ClaudeArgv(ClaudeInput{Stage: "deploy", Issue: "1"}); err == nil {
		t.Error("unknown stage accepted")
	}
	if _, err := ClaudeArgv(ClaudeInput{Stage: "build"}); err == nil {
		t.Error("empty issue accepted")
	}
}

func TestClaudeArgvPromptOverride(t *testing.T) {
	got, err := ClaudeArgv(ClaudeInput{Stage: "build", Issue: "7", MaxBudgetUSD: 1, Prompt: "do it"})
	if err != nil || got[1] != "-p" && got[2] != "do it" {
		t.Fatalf("%q %v", got[:3], err)
	}
	if got[2] != "do it" {
		t.Errorf("prompt = %q", got[2])
	}
}

func TestPluginsAreSwitchedOffInSettings(t *testing.T) {
	got, _ := ClaudeArgv(ClaudeInput{Stage: "triage", Issue: "1", MaxBudgetUSD: 1, Plugins: []string{"p@m"}})
	for i, a := range got {
		if a == "--settings" {
			if want := `"enabledPlugins":{"p@m":false}`; !contains(got[i+1], want) {
				t.Errorf("settings %s lacks %s", got[i+1], want)
			}
			return
		}
	}
	t.Fatal("no --settings")
}

func TestSafeCommandsRows(t *testing.T) {
	rows := []struct {
		p    string
		safe bool
	}{
		{"make test", true}, {"make *", true}, {"make:*", true}, {"go test *", true}, {"git diff *", true},
		{"bun test *", false}, {"bash x", false}, {"python3 x", false}, {"curl *", false}, {"gh pr *", false},
		{"git push", false}, {"git -c a=b log", false}, {"git *", false}, {"git -C x push", false},
		{"npm publish", false}, {"npm test", true}, {"./run", false}, {"A=1 make", false}, {"make a;b", false},
		{"ma*ke", false}, {"", false}, {"echo $(x)", false},
	}
	for _, r := range rows {
		if got := !refused(r.p); got != r.safe {
			t.Errorf("%q safe = %v, want %v", r.p, got, r.safe)
		}
	}
}
