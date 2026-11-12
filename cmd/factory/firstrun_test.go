package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
	"github.com/KaaS-team/factory/internal/config"
)

// firstRunFixture puts a fake auditor on PATH, a fake GitHub on GITHUB_API_URL and a fake dispatcher
// under the configured name. It returns the dispatcher and a counter of pull requests opened.
func firstRunFixture(t *testing.T) (*porttest.Dispatcher, *atomic.Int32) {
	t.Helper()
	report, err := filepath.Abs("../../internal/firstrun/testdata/report.v1.json")
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	if err := os.WriteFile(filepath.Join(bin, "auditor"), []byte("#!/bin/sh\ncat "+report+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))

	var opened atomic.Int32
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost && r.URL.Path == "/repos/o/r/pulls" {
			opened.Add(1)
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"number":7}`))
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(gh.Close)
	t.Setenv(envGitHubURL, gh.URL)
	t.Setenv(envGitHubToken, "t")
	t.Setenv("FACTORY_REPO", "o/r")
	t.Setenv("FACTORY_DISPATCHER", "fake")
	t.Chdir(t.TempDir())

	d := porttest.NewDispatcher(1)
	dispatchers["fake"] = func(context.Context, config.Config) (api.Dispatcher, error) { return d, nil }
	t.Cleanup(func() { delete(dispatchers, "fake") })
	return d, &opened
}

// TestFirstRunReportsWithoutDispatching: with no --fix the command audits and prints, spending nothing.
func TestFirstRunReportsWithoutDispatching(t *testing.T) {
	d, opened := firstRunFixture(t)
	out, _, err := runCLI(t, "first-run")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "## Top 3 risks") || len(d.Sessions) != 0 || opened.Load() != 0 {
		t.Fatalf("sessions=%d prs=%d\n%s", len(d.Sessions), opened.Load(), out)
	}
}

// TestFirstRunFixDispatchesOneBuildAndOpensADraftPR: --fix runs the configured dispatcher once and
// opens one draft pull request on the configured repository.
func TestFirstRunFixDispatchesOneBuildAndOpensADraftPR(t *testing.T) {
	d, opened := firstRunFixture(t)
	out, _, err := runCLI(t, "first-run", "--fix")
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Sessions) != 1 || opened.Load() != 1 || !strings.Contains(out, "Draft pull request #7 opened") {
		t.Fatalf("sessions=%d prs=%d\n%s", len(d.Sessions), opened.Load(), out)
	}
}

// TestFirstRunFixNeedsAKnownDispatcher: a dispatcher the config names but nothing builds is an error, not a report.
func TestFirstRunFixNeedsAKnownDispatcher(t *testing.T) {
	firstRunFixture(t)
	t.Setenv("FACTORY_DISPATCHER", "nope")
	if _, _, err := runCLI(t, "first-run", "--fix"); err == nil || !strings.Contains(err.Error(), "nope") {
		t.Fatalf("got %v", err)
	}
}
