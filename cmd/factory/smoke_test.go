package main

import (
	"errors"
	"strings"
	"testing"
)

// With no repository set, `factory smoke` says what to set and exits 2.
func TestSmokeWithoutRepoExplainsAndExits2(t *testing.T) {
	t.Setenv("FACTORY_SMOKE_REPO", "")
	t.Setenv("GITHUB_TOKEN", "")
	_, _, err := runCLI(t, "smoke")
	var ec interface{ ExitCode() int }
	if err == nil || !errors.As(err, &ec) || ec.ExitCode() != 2 {
		t.Fatalf("want exit 2, got %v", err)
	}
	if !strings.Contains(err.Error(), "FACTORY_SMOKE_REPO=owner/name") {
		t.Fatalf("no hint: %v", err)
	}
}

// With a repository set, the command reaches smoke.Run: it tries the GitHub API and fails there, not with exit 2.
func TestSmokeWithRepoRunsTheLoop(t *testing.T) {
	t.Setenv("FACTORY_SMOKE_REPO", "o/r")
	t.Setenv("GITHUB_TOKEN", "t")
	t.Setenv(envGitHubURL, "http://127.0.0.1:1")
	_, _, err := runCLI(t, "smoke", "--timeout", "2s")
	var ec interface{ ExitCode() int }
	if err == nil || errors.As(err, &ec) || !strings.Contains(err.Error(), "smoke: create issue") {
		t.Fatalf("got %v", err)
	}
}
