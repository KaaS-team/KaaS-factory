// Package quickstart keeps README.md honest: it runs the quickstart commands in a temp git repo and
// checks that every `factory` command in a README code block exists.
package quickstart

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var factoryBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "quickstart")
	if err != nil {
		panic(err)
	}
	factoryBin = filepath.Join(dir, "factory")
	cmd := exec.Command("go", "build", "-o", factoryBin, "./cmd/factory")
	cmd.Dir = filepath.Join("..", "..")
	if out, err := cmd.CombinedOutput(); err != nil {
		panic("build: " + err.Error() + "\n" + string(out))
	}
	code := m.Run()
	_ = os.RemoveAll(dir)
	os.Exit(code)
}

func readme(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "README.md"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// blocks returns the lines of every fenced code block of the given language in s.
func blocks(s, lang string) []string {
	var out []string
	in := false
	for _, l := range strings.Split(s, "\n") {
		switch {
		case strings.HasPrefix(l, "```"+lang) && !in && strings.TrimPrefix(l, "```") == lang:
			in = true
		case strings.HasPrefix(l, "```") && in:
			in = false
		case in:
			out = append(out, l)
		}
	}
	return out
}

// quickstart returns the README's Quickstart section.
func quickstart(t *testing.T) string {
	t.Helper()
	s := readme(t)
	_, rest, ok := strings.Cut(s, "\n## Quickstart\n")
	if !ok {
		t.Fatal("README has no Quickstart section")
	}
	sec, _, _ := strings.Cut(rest, "\n## ")
	return sec
}

func TestREADMEUnder150Lines(t *testing.T) {
	if n := strings.Count(readme(t), "\n"); n >= 150 {
		t.Fatalf("README is %d lines, want under 150", n)
	}
}

func TestREADMEHasMermaidAndTiers(t *testing.T) {
	s := readme(t)
	if len(blocks(s, "mermaid")) == 0 {
		t.Error("no mermaid diagram")
	}
	for _, h := range []string{"## Quickstart", "## The loop", "## CLI", "## MCP", "## Tiers"} {
		if !strings.Contains(s, "\n"+h+"\n") {
			t.Errorf("missing section %q", h)
		}
	}
	for _, tier := range []string{"Solo", "Team", "Org", "Enterprise"} {
		if !strings.Contains(s, "| "+tier+" |") {
			t.Errorf("tier table has no %s row", tier)
		}
	}
}

var flagRe = regexp.MustCompile(`^--?[A-Za-z]`)

// TestEveryREADMECommandExists walks every sh code block and checks that each `factory <cmd>` names a
// real command, by asking the built binary for its help.
func TestEveryREADMECommandExists(t *testing.T) {
	seen := 0
	for _, l := range blocks(readme(t), "sh") {
		f := strings.Fields(l)
		if len(f) < 2 || f[0] != "factory" {
			continue
		}
		var path []string
		for _, w := range f[1:] {
			if flagRe.MatchString(w) || strings.ContainsAny(w, `"<`) {
				break
			}
			path = append(path, w)
		}
		if len(path) == 0 {
			t.Errorf("no command in %q", l)
			continue
		}
		seen++
		out, err := exec.Command(factoryBin, append(path, "--help")...).CombinedOutput()
		if err != nil {
			t.Errorf("README runs %q but `factory %s --help` failed: %v\n%s", l, strings.Join(path, " "), err, out)
		}
	}
	if seen < 5 {
		t.Fatalf("walked only %d factory commands; the walker is broken", seen)
	}
}

func fake(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
}

// TestQuickstartRuns runs the README's quickstart commands in a temp git repo with fakes for the
// auditor, gh, claude and go, and asserts each exits 0. No network, token or model is used.
func TestQuickstartRuns(t *testing.T) {
	report, err := filepath.Abs(filepath.Join("..", "..", "internal", "firstrun", "testdata", "report.v1.json"))
	if err != nil {
		t.Fatal(err)
	}
	bin := t.TempDir()
	fake(t, bin, "auditor", "cat "+report)
	for _, n := range []string{"gh", "claude", "go"} {
		fake(t, bin, n, "exit 0")
	}
	repo := t.TempDir()
	env := []string{"PATH=" + bin + ":/usr/bin:/bin:/usr/local/bin", "HOME=" + t.TempDir(), "GOTOOLCHAIN=local"}
	run := func(name string, args ...string) {
		t.Helper()
		c := exec.Command(name, args...)
		c.Dir, c.Env = repo, env
		var out bytes.Buffer
		c.Stdout, c.Stderr = &out, &out
		if err := c.Run(); err != nil {
			t.Fatalf("%s %s: %v\n%s", name, strings.Join(args, " "), err, out.String())
		}
	}
	run("git", "init", "-q")

	ran := 0
	for _, l := range blocks(quickstart(t), "sh") {
		f := strings.Fields(l)
		if len(f) < 2 || f[0] != "factory" {
			continue
		}
		args := f[1:]
		if args[0] == "init" {
			// The README form asks questions on a terminal; a test has none.
			args = append(args, "--yes", "--tracker", "github")
		}
		run(factoryBin, args...)
		ran++
	}
	if ran != 3 {
		t.Fatalf("quickstart ran %d commands, want 3", ran)
	}
	if _, err := os.Stat(filepath.Join(repo, ".factory", "factory.yaml")); err != nil {
		t.Fatalf("init wrote no factory.yaml: %v", err)
	}
}
