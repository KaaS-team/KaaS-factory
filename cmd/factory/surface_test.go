package main

import (
	"os"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/pkg/sandbox"
	"gopkg.in/yaml.v3"
)

// TestBrowserPackCommandParses: the command line the browser pack runs parses against the mounted command.
func TestBrowserPackCommandParses(t *testing.T) {
	data, err := os.ReadFile("../../packs/checks/browser/pack.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Command string `yaml:"command"`
	}
	if err := yaml.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(p.Command)
	if len(f) < 2 || f[0] != "factory" {
		t.Fatalf("pack command %q does not start with factory", p.Command)
	}
	stdout, _, err := runCLI(t, append(f[1:], "--help")...)
	if err != nil {
		t.Fatalf("%q: %v", p.Command, err)
	}
	if !strings.Contains(stdout, "FACTORY_GATES") {
		t.Errorf("help does not describe the gate line:\n%s", stdout)
	}
}

// TestA2ARefusesWithoutToken: the mounted a2a command refuses to start with no bearer token.
func TestA2ARefusesWithoutToken(t *testing.T) {
	t.Setenv("FACTORY_A2A_TOKEN", "")
	_, _, err := runCLI(t, "a2a", "--addr", "127.0.0.1:0")
	if err == nil || !strings.Contains(err.Error(), "FACTORY_A2A_TOKEN") {
		t.Fatalf("got %v", err)
	}
}

// TestA2ADeps_NeedsGitHub: only the github tracker can file tickets for a2a.
func TestA2ADeps_NeedsGitHub(t *testing.T) {
	_, err := a2aDepsFor(config.Config{Tracker: "linear"})
	if err == nil || !strings.Contains(err.Error(), "tracker github") {
		t.Fatalf("got %v", err)
	}
}

// TestMain lets this test binary be the jail helper: with a sandbox request in the environment it
// runs main, whose first call must hand over to the real program.
func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv("KAAS_SANDBOX_HELPER"); ok {
		main()
		return
	}
	os.Exit(m.Run())
}

// TestMainEntersTheSandboxHelper: a command built by sandbox.Command, run through main, execs the
// requested program with only the spec's environment.
func TestMainEntersTheSandboxHelper(t *testing.T) {
	dir := t.TempDir()
	cmd, err := sandbox.Command(t.Context(), sandbox.Spec{Workdir: dir, ReadOnly: []string{"/"}, ReadWrite: []string{dir}, AllowNet: true,
		Env: []string{"WHO=jail"}}, "sh", "-c", "echo $WHO")
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != "jail" {
		t.Fatalf("out %q err %v", out, err)
	}
}

// TestCanJail: sandbox: true wraps only where the host can enforce a jail.
func TestCanJail(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    sandbox.Capabilities
		want bool
	}{
		{"none", sandbox.Capabilities{Rlimits: true}, false},
		{"landlock", sandbox.Capabilities{Landlock: true}, true},
		{"sandbox-exec", sandbox.Capabilities{SandboxExec: true}, true},
	} {
		if got := canJail(tc.c); got != tc.want {
			t.Errorf("%s: got %v", tc.name, got)
		}
	}
}
