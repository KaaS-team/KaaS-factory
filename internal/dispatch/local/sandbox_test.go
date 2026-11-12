package local

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

// TestMain lets this test binary act as the jail helper the sandbox re-executes.
func TestMain(m *testing.M) {
	if err := sandbox.MaybeEnter(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(m.Run())
}

func sandboxed(t *testing.T, body string, environ []string) (*Dispatcher, string) {
	t.Helper()
	wt := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := New(ctx, Config{Worktrees: dirWorktrees{wt}, Binary: script(t, body), Environ: environ, Sandbox: true, Now: time.Now})
	if err != nil {
		t.Fatal(err)
	}
	return d, wt
}

// Acceptance: with sandbox on, the built command is the jail helper carrying the argv and an
// environment with no provider key; the parent environment never reaches the process directly.
func TestSandboxCommandWrapsArgvAndDropsProviderKeys(t *testing.T) {
	parent := []string{"PATH=" + os.Getenv("PATH"), "ANTHROPIC_API_KEY=k1", "OPENAI_API_KEY=k2"}
	d, wt := sandboxed(t, "true\n", parent)
	bin := d.cfg.Binary
	cmd, err := d.command(context.Background(), []string{bin, "-p"}, wt, childEnv(parent, nil))
	if err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	if cmd.Path != self || cmd.Dir != wt {
		t.Fatalf("path %q dir %q, want the helper %q in %q", cmd.Path, cmd.Dir, self, wt)
	}
	if len(cmd.Env) != 1 || !strings.HasPrefix(cmd.Env[0], "KAAS_SANDBOX_HELPER=") {
		t.Fatalf("env is not only the helper request: %v", cmd.Env)
	}
	req := cmd.Env[0]
	if !strings.Contains(req, bin) || strings.Contains(req, "ANTHROPIC_") || strings.Contains(req, "OPENAI_") {
		t.Fatalf("request lacks the argv or leaks a key: %s", req)
	}
}

func TestSandboxOffRunsTheAgentDirectly(t *testing.T) {
	d, wt := newLocal(t, "true\n", nil)
	cmd, err := d.command(context.Background(), []string{d.cfg.Binary}, wt, []string{"A=1"})
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path != d.cfg.Binary || len(cmd.Env) != 1 || cmd.Env[0] != "A=1" {
		t.Fatalf("path %q env %v", cmd.Path, cmd.Env)
	}
}

// Dispatch through the helper end to end: the agent runs in its worktree and sees no provider key.
func TestSandboxDispatchRunsAgent(t *testing.T) {
	parent := []string{"PATH=" + os.Getenv("PATH"), "ANTHROPIC_API_KEY=k1"}
	d, wt := sandboxed(t, "env > env.txt\n", parent)
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	wait(t, d, s)
	got := read(t, wt+"/env.txt")
	if strings.Contains(got, "ANTHROPIC_") || !strings.Contains(got, "PATH=") {
		t.Fatalf("env:\n%s", got)
	}
}
