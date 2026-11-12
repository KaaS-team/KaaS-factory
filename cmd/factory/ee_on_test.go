//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestEECommandsListed: --help lists the ee commands, and policy exits non-zero on a deny.
func TestEECommandsListed(t *testing.T) {
	out, _, err := runCLI(t, "--help")
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range []string{"policy", "scim"} {
		if !strings.Contains(out, c) {
			t.Errorf("--help lacks %s", c)
		}
	}
	rules := filepath.Join(t.TempDir(), "p.yaml")
	if err := os.WriteFile(rules, []byte("rules:\n  - id: ok\n    effect: allow\n    roles: [owner]\n    actions: [merge]\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if o, _, err := runCLI(t, "policy", "merge", "--rules", rules, "--role", "owner"); err != nil || !strings.HasPrefix(o, "allow ok") {
		t.Errorf("owner merge: %q %v", o, err)
	}
	if o, _, err := runCLI(t, "policy", "merge", "--rules", rules, "--role", "viewer"); err == nil || !strings.HasPrefix(o, "deny default-deny") {
		t.Errorf("viewer merge: %q %v", o, err)
	}
}
