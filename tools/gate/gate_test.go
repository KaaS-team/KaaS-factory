// Package gate tests that gate.sh, the fallback for hosts without just, cannot drift from the justfile and CI.
package gate

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

func read(t *testing.T, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", rel))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func match(t *testing.T, src, re string) string {
	t.Helper()
	m := regexp.MustCompile(re).FindStringSubmatch(src)
	if m == nil {
		t.Fatalf("no match for %q", re)
	}
	return m[1]
}

func TestStepsMatchJustfile(t *testing.T) {
	just := strings.Fields(match(t, read(t, "justfile"), `(?m)^check:(.*)$`))
	sh := strings.Fields(match(t, read(t, "gate.sh"), `(?m)^STEPS="(.*)"$`))
	if !slices.Equal(just, sh) {
		t.Fatalf("justfile check steps %v differ from gate.sh STEPS %v", just, sh)
	}
	for _, s := range sh {
		if !strings.Contains(read(t, "gate.sh"), "step_"+s+"()") {
			t.Errorf("gate.sh has no step_%s", s)
		}
	}
}

func TestLintPinMatchesCI(t *testing.T) {
	pin := match(t, read(t, "justfile"), `(?m)^lint_version := "(.*)"$`)
	ci := match(t, read(t, ".github/workflows/go.yml"), `(?m)^\s+version: (v[\d.]+)$`)
	if pin != ci {
		t.Fatalf("justfile lint_version %s differs from .github/workflows/go.yml %s", pin, ci)
	}
}

// TestLintPicksPinned runs gate.sh lint with fake go and golangci-lint on PATH.
func TestLintPicksPinned(t *testing.T) {
	pin := match(t, read(t, "justfile"), `(?m)^lint_version := "(.*)"$`)
	for _, tc := range []struct{ name, have, want string }{
		{"older binary", "2.5.0", "GO go1.26.7 run github.com/golangci/golangci-lint/v2/cmd/golangci-lint@" + pin + " run ./..."},
		{"pinned binary", strings.TrimPrefix(pin, "v"), "LINT run ./..."},
	} {
		t.Run(tc.name, func(t *testing.T) {
			bin := t.TempDir()
			script := func(name, body string) {
				if err := os.WriteFile(filepath.Join(bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			script("golangci-lint", `if [ "$1" = version ]; then echo "golangci-lint has version `+tc.have+` built with go1.25.1"; else echo "LINT $*"; fi`)
			script("go", `echo "GO $GOTOOLCHAIN $*"`)
			cmd := exec.Command("sh", "gate.sh", "lint")
			cmd.Dir = filepath.Join("..", "..")
			cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("%v: %s", err, out)
			}
			if got := strings.TrimSpace(string(out)); got != tc.want {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}
