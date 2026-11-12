// SPDX-License-Identifier: LicenseRef-KaaS-EE

package ee_test

import (
	"os/exec"
	"strings"
	"testing"
)

// TestNoEEFilesWithoutTag: a build without -tags ee compiles none of the enterprise packages, and
// with the tag it compiles all three.
func TestNoEEFilesWithoutTag(t *testing.T) {
	goBin, err := exec.LookPath("go")
	if err != nil {
		t.Skip("go is not on PATH")
	}
	list := func(args ...string) string {
		cmd := exec.Command(goBin, append([]string{"list", "-e", "-f", "{{.ImportPath}} {{len .GoFiles}}"}, append(args, "./...")...)...)
		out, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("go list: %v\n%s", err, out)
		}
		return string(out)
	}
	for _, line := range strings.Split(strings.TrimSpace(list()), "\n") {
		if strings.Contains(line, "/ee/") && !strings.HasSuffix(line, " 0") {
			t.Errorf("compiled without the ee tag: %s", line)
		}
	}
	withTag := list("-tags", "ee")
	for _, pkg := range []string{"ee/policy", "ee/scim", "ee/sso"} {
		ok := false
		for _, line := range strings.Split(withTag, "\n") {
			if strings.Contains(line, "/"+pkg+" ") && !strings.HasSuffix(line, " 0") {
				ok = true
			}
		}
		if !ok {
			t.Errorf("%s has no files with -tags ee", pkg)
		}
	}
}
