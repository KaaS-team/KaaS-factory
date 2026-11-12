package packs

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const migrationPack = "type: specs.factory/migration\nname: a.b\ndescription: d\nsteps:\n  - name: s\n    files: [{glob: \"*.txt\"}]\n    prompt: hello\n"

func pinnedRoot(t *testing.T, content string, pinSHA string) string {
	t.Helper()
	root := t.TempDir()
	sha := strings.Repeat("a", 40)
	ref := "o/r@" + sha + "#workflows/m.yaml"
	r, _ := ParseRef(ref)
	if err := writeFile(cachePath(root, r), []byte(content)); err != nil {
		t.Fatal(err)
	}
	if pinSHA == "" {
		h := sha256.Sum256([]byte(content))
		pinSHA = hex.EncodeToString(h[:])
	}
	l := NewLock()
	if err := l.Put(Entry{Kind: KindWorkflow, Ref: ref, SHA: sha, SHA256: pinSHA, Licence: "MIT"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteLock(filepath.Join(root, LockFile), l); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "x.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestMigratePromptStepWithoutAgentFails(t *testing.T) {
	root := pinnedRoot(t, migrationPack, "")
	out, err := run(t, NewPacksCommand(), "migrate", "--root", root, "o/r#workflows/m.yaml")
	// No agent is wired into the command, so the prompt step is handed off and the run fails, not "ran".
	if err == nil || !strings.Contains(err.Error(), "no agent configured") || !strings.Contains(out, "prompt: hello\nfiles: x.txt") {
		t.Fatalf("%q %v", out, err)
	}
}

func TestMigrateRefusesUnpinnedOrChangedPack(t *testing.T) {
	root := pinnedRoot(t, migrationPack, "")
	if _, err := run(t, NewPacksCommand(), "migrate", "--root", root, "o/r#workflows/other.yaml"); err == nil || !strings.Contains(err.Error(), "not pinned") {
		t.Fatalf("unpinned: %v", err)
	}
	root = pinnedRoot(t, migrationPack, strings.Repeat("0", 64))
	if _, err := run(t, NewPacksCommand(), "migrate", "--root", root, "o/r#workflows/m.yaml"); err == nil || !strings.Contains(err.Error(), "does not match factory.lock") {
		t.Fatalf("changed: %v", err)
	}
}
