//go:build darwin

package sandbox

import (
	"os"
	"path/filepath"
	"slices"
	"testing"
)

// The helper runs with only the jail request in its environment, so Probe must find
// sandbox-exec without PATH; a PATH lookup there made the macOS jail a silent no-op.
func TestProbeFindsSandboxExecWithoutPath(t *testing.T) {
	t.Setenv("PATH", "")
	if !Probe().SandboxExec {
		t.Fatal("sandbox-exec not found with an empty PATH")
	}
}

// sandbox-exec matches real paths, so a writable path behind a symlink gets its real form too.
func TestResolvedAddsRealPathOfSymlinkedWritable(t *testing.T) {
	real := t.TempDir()
	link := filepath.Join(t.TempDir(), "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(real)
	got := resolved(Spec{Workdir: link, ReadWrite: []string{"/nonexistent-x"}}).ReadWrite
	if !slices.Contains(got, want) || !slices.Contains(got, "/nonexistent-x") {
		t.Fatalf("ReadWrite = %v, want it to hold %s", got, want)
	}
}
