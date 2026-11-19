package smoke

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// liveCommands are the four commands a new user runs first. See docs/smoke.md.
var liveCommands = [][]string{{"doctor"}, {"first-run", "--dry-run"}, {"status", "--json"}, {"report"}}

// liveCommandEnv is the process environment for the factory binary: the sandbox repo, the GitHub
// tracker and the local dispatcher, the token for gh and the API, and no ANTHROPIC_* variable
// (doctor fails on one, and a session runs under the operator's login).
func liveCommandEnv(e Env) []string {
	var env []string
	for _, kv := range os.Environ() {
		if k, _, _ := strings.Cut(kv, "="); !strings.HasPrefix(k, "ANTHROPIC_") && !strings.HasPrefix(k, "FACTORY_") {
			env = append(env, kv)
		}
	}
	return append(env, "FACTORY_REPO="+e.Owner+"/"+e.Repo, "FACTORY_TRACKER=github", "FACTORY_DISPATCHER=local",
		"GITHUB_TOKEN="+e.Token, "GH_TOKEN="+e.Token)
}

// TestLiveCommands runs doctor, first-run --dry-run, status --json and report against FACTORY_SMOKE_REPO
// and checks each exits 0 with output. It builds the binary from this checkout.
func TestLiveCommands(t *testing.T) {
	e, skip := FromEnv(os.Getenv)
	if skip != "" {
		t.Skip("live smoke test is opt-in: " + skip)
	}
	_, file, _, _ := runtime.Caller(0)
	bin := filepath.Join(t.TempDir(), "factory")
	build := exec.Command("go", "build", "-o", bin, "./cmd/factory")
	build.Dir = filepath.Join(filepath.Dir(file), "..", "..")
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build factory: %v\n%s", err, out)
	}
	work := t.TempDir() // the commands read the repo in the working directory
	if out, err := exec.Command("git", "-C", work, "init", "-q").CombinedOutput(); err != nil {
		t.Fatalf("git init: %v\n%s", err, out)
	}
	for _, args := range liveCommands {
		t.Run(args[0], func(t *testing.T) {
			if args[0] == "first-run" {
				if _, err := exec.LookPath("auditor"); err != nil {
					t.Skip("auditor is not on PATH; install it with: cargo install --git https://github.com/KaaS-team/auditor")
				}
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			cmd := exec.CommandContext(ctx, bin, args...)
			cmd.Dir, cmd.Env = work, liveCommandEnv(e)
			var stdout, stderr bytes.Buffer
			cmd.Stdout, cmd.Stderr = &stdout, &stderr
			if err := cmd.Run(); err != nil {
				t.Fatalf("factory %s: %v\n%s%s", strings.Join(args, " "), err, stdout.String(), stderr.String())
			}
			if strings.TrimSpace(stdout.String()) == "" {
				t.Fatalf("factory %s printed nothing", strings.Join(args, " "))
			}
			t.Logf("factory %s:\n%s", strings.Join(args, " "), stdout.String())
		})
	}
}
