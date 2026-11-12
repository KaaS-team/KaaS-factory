package docgen_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/docgen"
	"github.com/spf13/cobra"
)

func sampleRoot() *cobra.Command {
	root := &cobra.Command{Use: "tool", Short: "A sample tool"}
	root.PersistentFlags().Bool("verbose", false, "print more")
	run := &cobra.Command{Use: "run <ticket>", Short: "Run a ticket", Run: func(*cobra.Command, []string) {}}
	run.Flags().Int("slots", 6, "parallel sessions")
	run.Flags().StringP("repo", "r", "", "repository")
	hidden := &cobra.Command{Use: "secret", Short: "hidden", Hidden: true, Run: func(*cobra.Command, []string) {}}
	sub := &cobra.Command{Use: "queue", Short: "Show the queue"}
	sub.AddCommand(&cobra.Command{Use: "list", Short: "List entries", Run: func(*cobra.Command, []string) {}})
	root.AddCommand(run, hidden, sub)
	return root
}

func TestCLIMatchesGolden(t *testing.T) {
	got := docgen.CLI(sampleRoot())
	golden := filepath.Join("testdata", "cli.golden.md")
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(golden, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(golden)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("CLI output differs from golden:\n%s", got)
	}
	if strings.Contains(got, "secret") {
		t.Fatal("hidden command rendered")
	}
	if docgen.CLI(sampleRoot()) != got {
		t.Fatal("CLI is not deterministic")
	}
}

func TestConfigFreshness(t *testing.T) {
	got := docgen.Config()
	if docgen.Config() != got {
		t.Fatal("Config is not deterministic")
	}
	want, err := os.ReadFile(filepath.Join("..", "..", "docs", "config.md"))
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatal("docs/config.md is stale; run: UPDATE_CONFIG_DOC=1 go test ./internal/docgen -run TestConfigWrite")
	}
}

func TestConfigWrite(t *testing.T) {
	if os.Getenv("UPDATE_CONFIG_DOC") == "" {
		t.Skip("set UPDATE_CONFIG_DOC=1 to regenerate docs/config.md")
	}
	if err := os.WriteFile(filepath.Join("..", "..", "docs", "config.md"), []byte(docgen.Config()), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestREADME(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	s := string(b)
	if n := strings.Count(s, "\n"); n >= 120 {
		t.Errorf("README has %d lines, want under 120", n)
	}
	if strings.ContainsRune(s, '—') || strings.ContainsRune(s, '–') {
		t.Error("README has a dash used as punctuation")
	}
	low := strings.ToLower(s)
	for _, w := range []string{"claude-", "opus", "sonnet", "haiku", "gpt", "fable", "token", "usd", "price"} {
		if strings.Contains(low, w) {
			t.Errorf("README mentions %q", w)
		}
	}
	for _, w := range []string{"brew install", "install.sh", "factory init", "factory first-run", "factory run"} {
		if !strings.Contains(s, w) {
			t.Errorf("README lacks %q", w)
		}
	}
}
