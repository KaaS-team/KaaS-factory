package plancmd

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/dispatch/local"
)

// fakeClaude installs a `claude` on PATH that records its argv, env and stdin-free prompt, and
// prints replies[n] (stream-json) on call n, repeating the last. It returns the record dir.
func fakeClaude(t *testing.T, replies ...string) string {
	t.Helper()
	dir := t.TempDir()
	for i, r := range replies {
		line, err := json.Marshal(map[string]any{"type": "result", "subtype": "success", "result": r})
		if err != nil {
			t.Fatal(err)
		}
		assistant := `{"type":"assistant","message":{"content":[{"type":"text","text":"working"}]}}` + "\n"
		if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("reply%d", i)), []byte(assistant+string(line)+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	script := `#!/bin/sh
d=` + dir + `
n=$(ls "$d" | grep -c '^argv')
printf '%s\0' "$@" > "$d/argv$n"
env > "$d/env$n"
pwd > "$d/pwd$n"
r="$d/reply$n"
[ -f "$r" ] || r="$d/reply` + fmt.Sprint(len(replies)-1) + `"
cat "$r"
`
	if err := os.WriteFile(filepath.Join(dir, "claude"), []byte(script), 0o700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	return dir
}

func planWith(t *testing.T, repo string) (string, error) {
	t.Helper()
	c := NewCommand(WithSpecFunc(LocalSpec("claude", repo)))
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetErr(&out)
	c.SetArgs([]string{"goal text"})
	err := c.ExecuteContext(context.Background())
	return out.String(), err
}

func argvOf(t *testing.T, dir string, n int) []string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, fmt.Sprintf("argv%d", n)))
	if err != nil {
		t.Fatal(err)
	}
	return strings.Split(strings.TrimSuffix(string(b), "\x00"), "\x00")
}

const badSpec = "A spec with no criteria.\n"

func TestLocalSpecPrintsDAG(t *testing.T) {
	dir := fakeClaude(t, mustRead(t, "testdata/spec5.md"))
	out, err := planWith(t, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "Wave 1:") || !strings.Contains(out, "Wire it") {
		t.Fatalf("no DAG in output:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(dir, "argv1")); err == nil {
		t.Fatal("a valid spec must not be retried")
	}
}

func TestLocalSpecRetriesOnceWithErrors(t *testing.T) {
	dir := fakeClaude(t, badSpec, mustRead(t, "testdata/spec5.md"))
	out, err := planWith(t, t.TempDir())
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "Wave 1:") {
		t.Fatalf("no DAG:\n%s", out)
	}
	second := strings.Join(argvOf(t, dir, 1), "\n")
	if !strings.Contains(second, "no acceptance criteria") {
		t.Fatalf("retry prompt lacks the validation errors:\n%s", second)
	}
}

func TestLocalSpecTwoInvalidFail(t *testing.T) {
	dir := fakeClaude(t, badSpec, badSpec, mustRead(t, "testdata/spec5.md"))
	// the plan command reports problems without failing, so call the SpecFunc directly
	_, err := LocalSpec("claude", t.TempDir())(context.Background(), "goal text")
	if err == nil || !strings.Contains(err.Error(), "no acceptance criteria") {
		t.Fatalf("want validation errors, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "argv2")); err == nil {
		t.Fatal("exactly one retry is allowed")
	}
}

func TestLocalSpecEnvHasNoProviderKeys(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-test")
	t.Setenv("ANTHROPIC_BASE_URL", "http://x")
	t.Setenv("KEEP_ME", "yes")
	dir := fakeClaude(t, mustRead(t, "testdata/spec5.md"))
	if _, err := planWith(t, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "env0"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "ANTHROPIC_") {
		t.Fatalf("child env leaks a provider key:\n%s", b)
	}
	if !strings.Contains(string(b), "KEEP_ME=yes") {
		t.Fatal("ordinary env must pass through")
	}
}

// The argv is the local dispatcher's own builder output; only the prompt, tools and permission mode differ.
func TestLocalSpecArgvFromLocalBuilder(t *testing.T) {
	dir := fakeClaude(t, mustRead(t, "testdata/spec5.md"))
	repo := t.TempDir()
	if _, err := planWith(t, repo); err != nil {
		t.Fatal(err)
	}
	got := argvOf(t, dir, 0)
	want, err := local.ClaudeArgv(local.ClaudeInput{Stage: "plan", Issue: "plan", MaxBudgetUSD: specBudgetUSD, Prompt: got[1]})
	if err != nil {
		t.Fatal(err)
	}
	want = want[1:] // the fake receives argv without argv[0]
	if len(got) != len(want) {
		t.Fatalf("argv length %d, builder %d\n%q\n%q", len(got), len(want), got, want)
	}
	for i := range want {
		if got[i] == want[i] {
			continue
		}
		if i > 0 && (want[i-1] == "--tools" || want[i-1] == "--permission-mode") {
			continue
		}
		t.Errorf("argv[%d] = %q, builder gives %q", i, got[i], want[i])
	}
	for i, a := range got {
		if a == "--tools" && got[i+1] != "Read,Grep,Glob" {
			t.Errorf("tools = %q, want read-only", got[i+1])
		}
		if a == "--permission-mode" && got[i+1] != "plan" {
			t.Errorf("permission mode = %q, want plan", got[i+1])
		}
	}
	pwd, _ := os.ReadFile(filepath.Join(dir, "pwd0"))
	if r, _ := filepath.EvalSymlinks(repo); !strings.Contains(string(pwd), r) {
		t.Errorf("ran in %q, want %q", pwd, r)
	}
}
