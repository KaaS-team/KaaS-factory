package main

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/review"
)

type editAgent func(dir string) error

func (f editAgent) Run(_ context.Context, dir, _ string) (string, error) { return "done", f(dir) }

func reviewRepo(t *testing.T) {
	t.Helper()
	d := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		c := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
		c.Dir = d
		if out, err := c.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	w := func(name, body string) {
		t.Helper()
		p := filepath.Join(d, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	run("init", "-q")
	w("a.go", "package a\n")
	w(".factory/checks/todo.md", "---\nname: no-todo\nglobs: \"**/*.go\"\n---\nRemove TODO comments.\n")
	w(".factory/checks/docs.md", "---\nname: docs-only\nglobs: \"**/*.md\"\n---\nNever runs on a go change.\n")
	run("add", ".")
	run("commit", "-qm", "init")
	w("a.go", "package a\n// TODO x\n")
	t.Chdir(d)
}

func runReview(t *testing.T, agent review.Agent) (string, error) {
	t.Helper()
	old := reviewAgent
	reviewAgent = agent
	t.Cleanup(func() { reviewAgent = old })
	var out bytes.Buffer
	root := newRoot()
	root.SetOut(&out)
	root.SetArgs([]string{"review"})
	err := root.Execute()
	return out.String(), err
}

// TestReviewCommandRunsSelectedPacks: `factory review` runs the pack that covers the change, not
// the one that does not, and an agent that edits nothing passes.
func TestReviewCommandRunsSelectedPacks(t *testing.T) {
	reviewRepo(t)
	out, err := runReview(t, editAgent(func(string) error { return nil }))
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(out, "pass\tno-todo") || strings.Contains(out, "docs-only") {
		t.Fatalf("out %q", out)
	}
}

// TestReviewCommandFailsOnPatch: an edit in the worktree is the finding, printed, and exits non-zero.
func TestReviewCommandFailsOnPatch(t *testing.T) {
	reviewRepo(t)
	out, err := runReview(t, editAgent(func(dir string) error {
		return os.WriteFile(filepath.Join(dir, "a.go"), []byte("package a\n"), 0o644)
	}))
	if err == nil || !strings.Contains(err.Error(), "1 of 1 checks did not pass") {
		t.Fatalf("err %v out %q", err, out)
	}
	if !strings.Contains(out, "fail\tno-todo") || !strings.Contains(out, "-// TODO x") {
		t.Fatalf("out %q", out)
	}
}
