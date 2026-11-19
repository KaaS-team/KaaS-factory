package eval

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

// goldenCheck compares got with testdata/golden/<name>. Run with EVAL_UPDATE_GOLDEN=1 to write it.
func goldenCheck(t *testing.T, name, got string) {
	t.Helper()
	path := filepath.Join("testdata", "golden", name)
	if os.Getenv("EVAL_UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(want) != got {
		t.Errorf("%s differs from golden:\n--- want\n%s\n--- got\n%s", name, want, got)
	}
}

// Every command's --help is pinned, so splitting NewCommand cannot change a flag or a word.
func TestEvalHelpGolden(t *testing.T) {
	for _, sub := range [][]string{{}, {"diff"}, {"check"}, {"replay"}, {"stats"}, {"compare"}, {"run"}, {"splits"}} {
		name := "help-" + strings.Join(append([]string{"eval"}, sub...), "-") + ".golden"
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			cmd := NewCommand()
			cmd.SetOut(&out)
			cmd.SetErr(&out)
			cmd.SetArgs(append(append([]string{}, sub...), "--help"))
			if err := cmd.ExecuteContext(context.Background()); err != nil {
				t.Fatal(err)
			}
			goldenCheck(t, name, out.String())
		})
	}
}

// A fake run's stdout, scorecard JSON and markdown are pinned byte for byte.
func TestEvalRunOutputGolden(t *testing.T) {
	dir := t.TempDir()
	lock := filepath.Join(dir, "factory.lock")
	if err := os.WriteFile(lock, []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	out, run := newTestCommand(t, dir, map[api.TicketID]bool{"1": true})
	outDir := filepath.Join(dir, "evals")
	if err := run("--workflow", "default", "--agent", "claude", "--packs", lock, "--fixtures", fixturesDir, "--out", outDir); err != nil {
		t.Fatal(err)
	}
	goldenCheck(t, "run-stdout.golden", strings.ReplaceAll(out.String(), dir, "$DIR"))
	for _, ext := range []string{".json", ".md"} {
		b, err := os.ReadFile(filepath.Join(outDir, "2026-11-12-default-claude"+ext))
		if err != nil {
			t.Fatal(err)
		}
		goldenCheck(t, "run"+ext+".golden", string(b))
	}
}
