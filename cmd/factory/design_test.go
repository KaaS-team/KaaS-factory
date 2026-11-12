package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// fakeNode puts a `node` on PATH that logs its argv and stdin and answers like the design pack:
// a delta naming "dynamic" exits 2 with a fallback, anything else succeeds. It returns the log path.
func fakeNode(t *testing.T) string {
	t.Helper()
	bin, log := t.TempDir(), filepath.Join(t.TempDir(), "calls")
	script := `#!/bin/sh
echo "$@" >> "` + log + `"
case "$2" in
tweak)
  if grep -q dynamic "$3/$4"; then echo '{"error":"dynamic","oid":"cond","message":"in a conditional"}'; exit 2; fi
  echo '{"applied":["App.tsx"]}' ;;
oid-stamp) echo '{"stamped":["B.tsx"]}' ;;
apply-edits) cat >> "` + log + `"; echo '{"original":"a","generated":"b","path":"App.tsx"}' ;;
esac
`
	if err := os.WriteFile(filepath.Join(bin, "node"), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	return log
}

func calls(t *testing.T, log string) string {
	t.Helper()
	b, _ := os.ReadFile(log)
	return string(b)
}

// TestDesignTweakRunsThePack: `design tweak` runs the pack's tweak on the tree and reports the files.
func TestDesignTweakRunsThePack(t *testing.T) {
	log := fakeNode(t)
	dir := t.TempDir()
	out, _, err := runCLI(t, "design", "--pack", "packs/design", "tweak", dir, "delta.json")
	if err != nil {
		t.Fatal(err)
	}
	var o struct {
		Deterministic bool
		Files         []string
	}
	if err := json.Unmarshal([]byte(out), &o); err != nil || !o.Deterministic || len(o.Files) != 1 {
		t.Fatalf("out %q err %v", out, err)
	}
	if got := calls(t, log); !strings.Contains(got, "design.js tweak "+dir+" delta.json") {
		t.Fatalf("pack calls: %q", got)
	}
}

// TestDesignTweakFailsWhenTheEditNeedsAnAgent: a fallback fails the command with the pack's reason,
// which a workflow check step routes to its agent step.
func TestDesignTweakFailsWhenTheEditNeedsAnAgent(t *testing.T) {
	fakeNode(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "delta.json"), []byte("dynamic"), 0o644); err != nil {
		t.Fatal(err)
	}
	_, _, err := runCLI(t, "design", "tweak", dir, "delta.json")
	if err == nil || !strings.Contains(err.Error(), "needs an agent") || !strings.Contains(err.Error(), "dynamic") {
		t.Fatalf("got %v", err)
	}
}

// TestDesignStampAndEdit: stamp lists the files it changed; edit sends the requests and the strip flag.
func TestDesignStampAndEdit(t *testing.T) {
	log := fakeNode(t)
	dir := t.TempDir()
	out, _, err := runCLI(t, "design", "stamp", dir)
	if err != nil || !strings.Contains(out, "B.tsx") {
		t.Fatalf("stamp: %q %v", out, err)
	}
	req := filepath.Join(dir, "req.json")
	if err := os.WriteFile(req, []byte(`[{"oid":"h","textContent":"Bye"}]`), 0o644); err != nil {
		t.Fatal(err)
	}
	out, _, err = runCLI(t, "design", "edit", "--strip-ids", dir, "App.tsx", req)
	if err != nil || !strings.Contains(out, `"generated":"b"`) {
		t.Fatalf("edit: %q %v", out, err)
	}
	got := calls(t, log)
	if !strings.Contains(got, "apply-edits --strip-ids") || !strings.Contains(got, `"oid":"h"`) || !strings.Contains(got, `"file":"App.tsx"`) {
		t.Fatalf("pack calls: %q", got)
	}
}

// TestDesignTweakOnTheRealPack drives the real node pack when its dependencies are installed.
func TestDesignTweakOnTheRealPack(t *testing.T) {
	pack, _ := filepath.Abs("../../packs/design")
	if _, err := os.Stat(filepath.Join(pack, "node_modules", "@babel", "standalone")); err != nil {
		t.Skip("run npm ci in packs/design")
	}
	dir := t.TempDir()
	src, err := os.ReadFile("../../internal/design/testdata/App.tsx")
	if err != nil {
		t.Fatal(err)
	}
	for name, body := range map[string]string{"App.tsx": string(src), "delta.json": `{"changes":[{"file":"App.tsx","oid":"h","kind":"text","text":"Bye"}]}`} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, _, err := runCLI(t, "design", "--pack", pack, "tweak", dir, "delta.json"); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(dir, "App.tsx")); !strings.Contains(string(got), "Bye") {
		t.Fatalf("tree not edited:\n%s", got)
	}
}
