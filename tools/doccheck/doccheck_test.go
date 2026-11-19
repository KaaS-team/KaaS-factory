package main

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

func TestMissingFlagsAbsentPaths(t *testing.T) {
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, "cmd"), 0o755); err != nil {
		t.Fatal(err)
	}
	doc := "`cmd/` and `gone/` and `cmd/nope.go` and `just check` and `--flag` and `a/*.go`"
	if err := os.WriteFile(filepath.Join(dir, "D.md"), []byte(doc), 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := Missing(dir, "D.md")
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"gone/", "cmd/nope.go"}; !slices.Equal(got, want) {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// TestRepoDocsNamePathsThatExist is the repo's doc check: every backticked path in README.md and AGENTS.md exists.
func TestRepoDocsNamePathsThatExist(t *testing.T) {
	for _, doc := range []string{"README.md", "AGENTS.md"} {
		got, err := Missing("../..", doc)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) > 0 {
			t.Errorf("%s names paths that do not exist: %v", doc, got)
		}
	}
}
