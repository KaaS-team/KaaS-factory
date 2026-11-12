package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/KaaS-team/factory/internal/docgen"
)

// TestCLIReferenceFresh fails when docs/cli-reference.md no longer matches the mounted command
// tree. UPDATE_GOLDEN=1 go test ./cmd/factory rewrites it.
func TestCLIReferenceFresh(t *testing.T) {
	path := filepath.Join("..", "..", "docs", "cli-reference.md")
	got := docgen.CLI(newRoot())
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != got {
		t.Fatalf("%s is stale; run UPDATE_GOLDEN=1 go test ./cmd/factory", path)
	}
}
