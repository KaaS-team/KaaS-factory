package main

import (
	"os"
	"path/filepath"
	"strings"
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
		w, g := strings.Split(string(want), "\n"), strings.Split(got, "\n")
		for i := 0; i < len(w) || i < len(g); i++ {
			var wl, gl string
			if i < len(w) {
				wl = w[i]
			}
			if i < len(g) {
				gl = g[i]
			}
			if wl != gl {
				t.Fatalf("%s is stale at line %d; run UPDATE_GOLDEN=1 go test ./cmd/factory\n file: %q\n tree: %q", path, i+1, wl, gl)
			}
		}
	}
}

// TestCLIReferenceMachineFree fails when a flag default bakes in this machine's temp or home
// directory, which made the reference pass on a laptop and go stale in CI.
func TestCLIReferenceMachineFree(t *testing.T) {
	here := docgen.CLI(newRoot())
	t.Setenv("TMPDIR", "/elsewhere-tmp")
	t.Setenv("HOME", "/elsewhere-home")
	if docgen.CLI(newRoot()) != here {
		t.Fatal("the CLI reference depends on TMPDIR or HOME; resolve that default when the command runs")
	}
}
