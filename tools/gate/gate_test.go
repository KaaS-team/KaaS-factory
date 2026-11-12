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
	ci := match(t, read(t, ".github/workflows/ci.yml"), `(?m)^\s+version: (v[\d.]+)$`)
	if pin != ci {
		t.Fatalf("justfile lint_version %s differs from .github/workflows/ci.yml %s", pin, ci)
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

// TestFmtPicksPinned runs gate.sh fmt with a PATH gofmt that flags every file and a pinned-toolchain gofmt
// that flags none. The fmt step must use the pinned one, the gofmt golangci-lint formats with.
func TestFmtPicksPinned(t *testing.T) {
	pin := match(t, read(t, "justfile"), `(?m)^lint_go := "(.*)"$`)
	bin, root := t.TempDir(), t.TempDir()
	script := func(path, body string) {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body+"\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script(filepath.Join(bin, "gofmt"), `echo path-gofmt.go`)
	script(filepath.Join(bin, "go"), `echo "`+root+`/$GOTOOLCHAIN"`)
	script(filepath.Join(root, pin, "bin", "gofmt"), `exit 0`)
	cmd := exec.Command("sh", "gate.sh", "fmt")
	cmd.Dir = filepath.Join("..", "..")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gate.sh fmt used the PATH gofmt, not the %s one: %v: %s", pin, err, out)
	}
}

// CI runs on linux only; the gate vets darwin too so a linux-only test helper used from a portable file fails here.
func TestVetCoversBothOSes(t *testing.T) {
	bin := t.TempDir()
	log := filepath.Join(bin, "log")
	if err := os.WriteFile(filepath.Join(bin, "go"), []byte("#!/bin/sh\necho \"$GOOS $*\" >> "+log+"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("sh", "gate.sh", "vet")
	cmd.Dir = filepath.Join("..", "..")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("gate.sh vet: %v: %s", err, out)
	}
	got, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	for _, goos := range []string{"linux", "darwin"} {
		if !strings.Contains(string(got), goos+" vet ./...") {
			t.Fatalf("gate.sh vet did not vet GOOS=%s; ran:\n%s", goos, got)
		}
	}
}
