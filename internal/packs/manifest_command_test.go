package packs

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writePack(t *testing.T, dir, name, body string) string {
	t.Helper()
	p := filepath.Join(dir, name, "pack.yaml")
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRunCommandRetriesUntilCheckPasses(t *testing.T) {
	dir := t.TempDir()
	flag := filepath.Join(dir, "flag")
	p := writePack(t, dir, "r", "name: r\nkind: check\nretry:\n  max_retries: 3\n  checks:\n    - type: shell\n      command: test -f "+flag+"\n")
	cmd := NewPacksCommand()
	cmd.SetArgs([]string{"run", "--unlocked", p, "touch", flag})
	cmd.SetOut(&bytes.Buffer{})
	cmd.SetErr(&bytes.Buffer{})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	cmd = NewPacksCommand()
	cmd.SetArgs([]string{"run", "--unlocked", writePack(t, dir, "nr", "name: nr\nkind: check\n"), "true"})
	cmd.SetErr(&bytes.Buffer{})
	if err := cmd.Execute(); err == nil || !strings.Contains(err.Error(), "no retry block") {
		t.Fatalf("err = %v", err)
	}
}

func TestMatchCommandListsTriggeredSkills(t *testing.T) {
	dir := t.TempDir()
	writePack(t, dir, "a", "name: always\nkind: skill\n")
	writePack(t, dir, "b", "name: sql\nkind: skill\npaths: ['**/*.sql']\n")
	var out bytes.Buffer
	cmd := NewPacksCommand()
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"match", dir, "--path", "x/y.sql"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if out.String() != "always\nsql\n" {
		t.Fatalf("out = %q", out.String())
	}
	out.Reset()
	cmd = NewPacksCommand()
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"match", dir})
	if err := cmd.Execute(); err != nil || out.String() != "always\n" {
		t.Fatalf("out=%q err=%v", out.String(), err)
	}
}

func TestVerifyFailsOnManifestHashMismatch(t *testing.T) {
	root := t.TempDir()
	ref := Ref{Owner: "o", Repo: "r", SHA: strings.Repeat("a", 40), Path: "checks/x/pack.yaml"}
	good := []byte("name: x\nkind: check\n")
	lock := NewLock()
	if err := lock.Put(Entry{Kind: KindCheck, Ref: ref.String(), SHA: ref.SHA, SHA256: digest(good), Licence: "MIT"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteLock(filepath.Join(root, LockFile), lock); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(cachePath(root, ref), []byte("name: tampered\nkind: check\n")); err != nil {
		t.Fatal(err)
	}
	cmd := NewPacksCommand()
	cmd.SetArgs([]string{"verify", "--root", root})
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	if err := cmd.Execute(); err == nil || !strings.Contains(out.String(), "content hash mismatch") {
		t.Fatalf("err=%v out=%s", err, out.String())
	}
	if err := writeFile(cachePath(root, ref), good); err != nil {
		t.Fatal(err)
	}
	cmd = NewPacksCommand()
	cmd.SetArgs([]string{"verify", "--root", root})
	cmd.SetOut(&out)
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
}

// lockedPack writes a pack into the cache path of a fresh root and pins it, returning the root and file.
func lockedPack(t *testing.T, body string) (string, string) {
	t.Helper()
	root := t.TempDir()
	ref := Ref{Owner: "o", Repo: "r", SHA: strings.Repeat("a", 40), Path: "checks/x/pack.yaml"}
	lock := NewLock()
	if err := lock.Put(Entry{Kind: KindCheck, Ref: ref.String(), SHA: ref.SHA, SHA256: digest([]byte(body)), Licence: "MIT"}); err != nil {
		t.Fatal(err)
	}
	if err := WriteLock(filepath.Join(root, LockFile), lock); err != nil {
		t.Fatal(err)
	}
	if err := writeFile(cachePath(root, ref), []byte(body)); err != nil {
		t.Fatal(err)
	}
	return root, cachePath(root, ref)
}

func runPack(root, pack string, extra ...string) (string, error) {
	cmd := NewPacksCommand()
	var out bytes.Buffer
	cmd.SetOut(&out)
	cmd.SetErr(&out)
	cmd.SetArgs(append(append([]string{"run", "--root", root}, extra...), pack, "touch", filepath.Join(root, "ran")))
	err := cmd.Execute()
	return out.String(), err
}

const retryPack = "name: x\nkind: check\nretry:\n  max_retries: 1\n  checks:\n    - type: shell\n      command: 'true'\n"

func TestRunRefusesPackNotInLock(t *testing.T) {
	root, _ := lockedPack(t, retryPack)
	stray := writePack(t, t.TempDir(), "s", retryPack+"# other\n")
	_, err := runPack(root, stray)
	if err == nil || !strings.Contains(err.Error(), stray) || !strings.Contains(err.Error(), LockFile) {
		t.Fatalf("err = %v, want one naming the pack and the lock", err)
	}
	if _, serr := os.Stat(filepath.Join(root, "ran")); serr == nil {
		t.Fatal("command ran for an unlocked pack")
	}
}

func TestRunRefusesLockedPackWithChangedHash(t *testing.T) {
	root, file := lockedPack(t, retryPack)
	if err := os.WriteFile(file, []byte(retryPack+"# tampered\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := runPack(root, file); err == nil || !strings.Contains(err.Error(), "content hash mismatch") {
		t.Fatalf("err = %v, want hash mismatch", err)
	}
}

func TestRunRunsLockedMatchingPack(t *testing.T) {
	root, file := lockedPack(t, retryPack)
	if out, err := runPack(root, file); err != nil || strings.Contains(out, "warning") {
		t.Fatalf("err = %v out = %s", err, out)
	}
	if _, err := os.Stat(filepath.Join(root, "ran")); err != nil {
		t.Fatal("command did not run")
	}
}

func TestRunUnlockedFlagWarnsOnce(t *testing.T) {
	root, _ := lockedPack(t, retryPack)
	stray := writePack(t, t.TempDir(), "s", retryPack+"# other\n")
	out, err := runPack(root, stray, "--unlocked")
	if err != nil || strings.Count(out, "warning") != 1 {
		t.Fatalf("err = %v out = %q", err, out)
	}
}
