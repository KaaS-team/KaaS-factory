package main

import (
	"os"
	"strings"
	"testing"

	"github.com/spf13/cobra"
)

// helpPaths lists every command path under c, depth first, in registration order.
func helpPaths(c *cobra.Command, prefix []string) [][]string {
	out := [][]string{prefix}
	for _, s := range c.Commands() {
		out = append(out, helpPaths(s, append(append([]string{}, prefix...), s.Name()))...)
	}
	return out
}

// TestHelpGolden pins the --help text of every command. Regenerate with UPDATE_GOLDEN=1.
func TestHelpGolden(t *testing.T) {
	var b strings.Builder
	for _, p := range helpPaths(newRoot(), nil) {
		out, _, err := runCLI(t, append(append([]string{}, p...), "--help")...)
		if err != nil {
			t.Fatalf("%v --help: %v", p, err)
		}
		b.WriteString("=== factory " + strings.Join(p, " ") + "\n" + out + "\n")
	}
	const file = "testdata/help.golden"
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(b.String()), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != b.String() {
		t.Errorf("--help output changed; rerun with UPDATE_GOLDEN=1 if intended")
	}
}
