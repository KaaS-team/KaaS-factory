package local

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Local runs use the operator's own git credentials, so a workflow file
// (which cloud tokens cannot push, #635) pushes from a local worktree.
func TestLocalWorktreeCanPushAWorkflowFile(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	git := func(dir string, args ...string) string {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.test", "-c", "commit.gpgsign=false"}, args...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return strings.TrimSpace(string(out))
	}
	remote := t.TempDir()
	git(remote, "init", "-q", "--bare", "-b", "main")
	repo := t.TempDir()
	git(repo, "init", "-q", "-b", "main")
	git(repo, "commit", "-q", "--allow-empty", "-m", "base")
	git(repo, "remote", "add", "origin", remote)
	git(repo, "push", "-q", "origin", "main")
	git(repo, "fetch", "-q", "origin")
	dir, err := GitWorktrees{Repo: repo, Root: t.TempDir()}.Add(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	wfDir := filepath.Join(dir, ".github", "workflows")
	if err := os.MkdirAll(wfDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(wfDir, "ci.yml"), []byte("name: ci\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(dir, "add", ".github/workflows/ci.yml")
	git(dir, "commit", "-q", "-m", "add workflow")
	git(dir, "push", "-q", "origin", bf.Branch)
	if got := git(remote, "show", bf.Branch+":.github/workflows/ci.yml"); got != "name: ci" {
		t.Fatalf("remote file %q", got)
	}
}

// Host git after a session never runs a hook the agent could have planted.
func TestWorktreeAddIgnoresHooks(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@e.test", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	run("commit", "-q", "--allow-empty", "-m", "i")
	run("update-ref", "refs/remotes/origin/main", "HEAD")
	marker := filepath.Join(t.TempDir(), "ran")
	hook := filepath.Join(repo, ".git", "hooks", "post-checkout")
	if err := os.MkdirAll(filepath.Dir(hook), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(hook, []byte("#!/bin/sh\ntouch "+marker+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	g := GitWorktrees{Repo: repo, Root: filepath.Join(t.TempDir(), "w")}
	if _, err := g.Add(context.Background(), bf); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err == nil {
		t.Fatal("post-checkout hook ran")
	}
}
