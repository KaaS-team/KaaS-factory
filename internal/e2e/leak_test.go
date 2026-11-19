package e2e

import (
	"context"
	"os/exec"
	"strings"
	"testing"
)

// TestWorldIgnoresInheritedGitDir builds the harness with GIT_DIR pointing at an outside repo and
// checks that repo gains no commit, so a gate run from a git hook cannot push to the real origin.
func TestWorldIgnoresInheritedGitDir(t *testing.T) {
	outside := t.TempDir()
	run := func(args ...string) string {
		cmd := exec.Command("git", append([]string{"-C", outside}, args...)...)
		cmd.Env = isolatedEnv()
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	run("init", "-q", "-b", "main")
	run("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "outside")
	before := run("rev-parse", "HEAD")
	t.Setenv("GIT_DIR", outside+"/.git")
	newWorld(t, context.Background(), nil)
	if after := run("rev-parse", "HEAD"); after != before {
		t.Fatalf("the harness committed into the repo named by GIT_DIR: %s -> %s", before, after)
	}
}
