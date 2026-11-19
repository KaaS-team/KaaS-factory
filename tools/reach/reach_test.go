// Package reach fails when an internal/ or pkg/ package is not reached from cmd/factory.
// A package no command imports is dead code or an unfinished wiring job; either way it is named here.
package reach

import (
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
)

const module = "github.com/KaaS-team/factory/"

// testOnly packages hold tests or test fakes. No command imports them by design.
var testOnly = map[string]string{
	"internal/api/porttest":               "fake ports used by cmd/factory tests",
	"internal/conformance":                "Symphony spec matrix, tests only",
	"internal/dispatch/broker/brokertest": "fake for the broker tests",
	"internal/e2e":                        "whole-loop test, tests only",
	"internal/provenance":                 "checks THIRD_PARTY_NOTICES.md in a test",
	"internal/store/conformance":          "suite that internal/store/crypt tests run",
	"internal/template":                   "skills test only, no non-test code",
}

// pendingWiring packages are finished but no command calls them yet. Each needs a wiring ticket.
// Wire one, then delete its line: the test fails if a listed package is reached.
var pendingWiring = map[string]string{
	"internal/dispatch/broker":  "per-action credential broker: wire into the sandbox session start",
	"internal/eval/judgecache":  "judge verdict cache: wire into `factory eval`",
	"internal/eval/replay":      "recorded eval replay: wire into `factory eval`",
	"internal/gate/lintdelta":   "lint-delta edit gate: wire into the build gate",
	"internal/graph/scanedit":   "scan and edit workflow: wire into `factory workflow`",
	"internal/observe/sampling": "trace sampling and OTLP usage mapping: wire into the observer",
	"internal/packs/astgrep":    "ast-grep pack: wire into `factory pack`",
	"internal/packs/depup":      "dependency-update tickets: wire into the cron scheduler",
	"internal/store/crypt":      "encrypted checkpoint store: wire into the store open path",
	"internal/tracker/safeout":  "agent write path: wire into the tracker apply stage",
	"pkg/agentrun":              "public dispatcher surface for other KaaS modules: re-export, keep",
	"pkg/sandbox/cachevol":      "sandbox cache volumes: wire into the sandbox",
	"pkg/sandbox/egress":        "sandbox egress proxy: wire into the sandbox",
}

func list(t *testing.T, args ...string) []string {
	t.Helper()
	out, err := exec.Command("go", args...).Output()
	if err != nil {
		t.Fatalf("go %s: %v", strings.Join(args, " "), err)
	}
	var pkgs []string
	for _, p := range strings.Fields(string(out)) {
		if rel, ok := strings.CutPrefix(p, module); ok && (strings.HasPrefix(rel, "internal/") || strings.HasPrefix(rel, "pkg/")) {
			pkgs = append(pkgs, rel)
		}
	}
	return pkgs
}

// touchTrees walks the source trees so go test's cache sees a new or removed package; the go list calls alone are invisible to it.
func touchTrees(t *testing.T) {
	t.Helper()
	for _, root := range []string{"../../internal", "../../pkg"} {
		err := filepath.WalkDir(root, func(string, fs.DirEntry, error) error { return nil })
		if err != nil {
			t.Fatal(err)
		}
		if _, err := os.ReadDir(root); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEveryPackageIsReachedFromACommand(t *testing.T) {
	touchTrees(t)
	// The ee build adds packages behind a tag, so a package either build reaches counts as reached.
	reached := append(list(t, "list", "-deps", "../../cmd/factory"), list(t, "list", "-tags", "ee", "-deps", "../../cmd/factory")...)
	for _, p := range list(t, "list", "../../internal/...", "../../pkg/...") {
		_, exempt := testOnly[p]
		_, pending := pendingWiring[p]
		isReached := slices.Contains(reached, p)
		switch {
		case isReached && (exempt || pending):
			t.Errorf("%s is reached from cmd/factory: delete its line from the exempt list", p)
		case !isReached && !exempt && !pending:
			t.Errorf("%s is not reached from cmd/factory: wire it into a command, delete it, or list it with a reason", p)
		}
	}
	for _, m := range []map[string]string{testOnly, pendingWiring} {
		for p := range m {
			// A directory check, not go list: a package built only on Linux does not list on darwin.
			if _, err := os.Stat(filepath.Join("../..", p)); err != nil {
				t.Errorf("%s is listed but does not exist: delete the line", p)
			}
		}
	}
}
