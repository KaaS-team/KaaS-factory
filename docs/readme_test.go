// Package docs holds tests that keep README.md true to the command tree.
package docs

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func read(t *testing.T, p string) string {
	t.Helper()
	b, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// TestReadmeListsEveryCommand fails when a top-level command in docs/cli-reference.md is missing from
// the README command list.
func TestReadmeListsEveryCommand(t *testing.T) {
	readme := read(t, "../README.md")
	skip := map[string]bool{"help": true, "completion": true, "docs": true}
	for _, m := range regexp.MustCompile(`(?m)^## factory ([a-z0-9-]+)$`).FindAllStringSubmatch(read(t, "cli-reference.md"), -1) {
		if skip[m[1]] {
			continue
		}
		if !strings.Contains(readme, "`"+m[1]+"`") {
			t.Errorf("README.md does not list the command %q", m[1])
		}
	}
}

// TestReadmeShape fails on a long README, a wrong repo name, or a missing install route.
func TestReadmeShape(t *testing.T) {
	readme := read(t, "../README.md")
	if n := strings.Count(readme, "\n"); n >= 150 {
		t.Errorf("README.md has %d lines; keep it under 150", n)
	}
	if strings.Contains(readme, "KaaS-factory") {
		t.Error("README.md uses the old repo name KaaS-factory; it is KaaS-team/factory")
	}
	for _, want := range []string{"brew install", "install.sh | sh", "go install github.com/KaaS-team/factory/cmd/factory@latest"} {
		if !strings.Contains(readme, want) {
			t.Errorf("README.md is missing the install route %q", want)
		}
	}
}
