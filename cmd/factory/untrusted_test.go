package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
)

func sh(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v: %v\n%s", args, err, out)
	}
}

// A run on a pull request from an author without write access gets the restricted argv (the deny
// list and the allowlisted Bash rules); a trusted author's run, and a run on an issue, do not.
func TestLocalDispatchRestrictsUntrustedAuthors(t *testing.T) {
	gh := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repos/acme/shop/issues/1": // a pull request by an outsider
			_, _ = w.Write([]byte(`{"number":1,"user":{"login":"mallory"},"pull_request":{"url":"x"}}`))
		case "/repos/acme/shop/issues/2": // a pull request by a maintainer
			_, _ = w.Write([]byte(`{"number":2,"user":{"login":"ann"},"pull_request":{"url":"x"}}`))
		case "/repos/acme/shop/issues/3": // a plain issue by an outsider
			_, _ = w.Write([]byte(`{"number":3,"user":{"login":"mallory"}}`))
		case "/repos/acme/shop/collaborators/mallory/permission":
			_, _ = w.Write([]byte(`{"permission":"read"}`))
		case "/repos/acme/shop/collaborators/ann/permission":
			_, _ = w.Write([]byte(`{"permission":"write"}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer gh.Close()
	t.Setenv("GITHUB_API_URL", gh.URL)
	t.Setenv("GITHUB_TOKEN", "t")

	origin, repo, bin := t.TempDir(), t.TempDir(), t.TempDir()
	sh(t, origin, "git", "init", "-q", "--bare", "-b", "main")
	sh(t, repo, "git", "clone", "-q", origin, ".")
	if err := os.WriteFile(filepath.Join(repo, "README"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	sh(t, repo, "git", "add", "-A")
	sh(t, repo, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--no-verify", "-m", "base")
	sh(t, repo, "git", "push", "-q", "origin", "HEAD:main")
	sh(t, repo, "git", "fetch", "-q", "origin")
	// A stand-in agent CLI that records its argv in the worktree it runs in.
	if err := os.WriteFile(filepath.Join(bin, "claude"), []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" > argv.txt\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	t.Chdir(repo)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := buildDispatcher(ctx, config.Config{Dispatcher: "local", Tracker: "github", Repo: "acme/shop", Slots: 3, Base: "main"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		ticket     api.TicketID
		restricted bool
	}{{"1", true}, {"2", false}, {"3", false}} {
		t.Run(string(tc.ticket), func(t *testing.T) {
			b := api.Brief{Ticket: tc.ticket, Attempt: 1, Name: "v9-" + string(tc.ticket) + "-a1.md", Repo: "acme/shop", Base: "main",
				Branch: "factory/" + string(tc.ticket) + "-a1", Text: "x"}
			if _, err := d.Dispatch(ctx, b); err != nil {
				t.Fatal(err)
			}
			file := filepath.Join(repo, ".factory", "worktrees", "factory-"+string(tc.ticket)+"-a1", "argv.txt")
			var got string
			for deadline := time.Now().Add(10 * time.Second); got == "" && time.Now().Before(deadline); time.Sleep(50 * time.Millisecond) {
				raw, _ := os.ReadFile(file)
				got = string(raw)
			}
			if got == "" {
				t.Fatal("the agent never ran")
			}
			if has := strings.Contains(got, "Bash(env:*)"); has != tc.restricted {
				t.Errorf("deny list in argv = %v, want %v", has, tc.restricted)
			}
		})
	}
}
