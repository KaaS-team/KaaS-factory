package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func gitIn(t *testing.T, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@t", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@t")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// TestCheckpointCommand drives `factory checkpoint` on a real repo: save, see what an agent changed,
// restore the tree, then drop the snapshot.
func TestCheckpointCommand(t *testing.T) {
	t.Chdir(t.TempDir())
	gitIn(t, "init", "-q")
	if err := os.WriteFile("a.txt", []byte("one\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	gitIn(t, "add", "a.txt")
	gitIn(t, "commit", "-q", "-m", "init")

	if out, _, err := runCLI(t, "checkpoint", "save", "s1", "1"); err != nil || !strings.HasPrefix(out, "saved 1 ") {
		t.Fatalf("save: %q, %v", out, err)
	}
	if err := os.WriteFile("a.txt", []byte("two\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile("new.txt", []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, _, err := runCLI(t, "checkpoint", "diff", "s1", "1")
	if err != nil || out != "M\ta.txt\nA\tnew.txt\n" {
		t.Fatalf("diff: %q, %v", out, err)
	}
	if _, _, err := runCLI(t, "checkpoint", "restore", "s1", "1"); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile("a.txt"); string(b) != "one\n" {
		t.Fatalf("a.txt = %q after restore, want the saved content", b)
	}
	if _, err := os.Stat("new.txt"); err == nil {
		t.Fatal("new.txt survived the restore")
	}
	if _, _, err := runCLI(t, "checkpoint", "drop", "s1"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runCLI(t, "checkpoint", "restore", "s1", "1"); err == nil {
		t.Fatal("restore after drop succeeded, want an error")
	}
	if _, _, err := runCLI(t, "checkpoint", "reap"); err != nil {
		t.Fatal(err)
	}
	if _, _, err := runCLI(t, "checkpoint", "save", "../x", "1"); err == nil {
		t.Fatal("a session id with .. was accepted")
	}
}
