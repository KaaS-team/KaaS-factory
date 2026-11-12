package main

import (
	"os"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/config"
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
