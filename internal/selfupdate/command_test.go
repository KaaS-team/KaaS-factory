package selfupdate

import (
	"bytes"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// releaseHere is a release whose asset matches the running platform, which is what Apply downloads.
func releaseHere(t *testing.T, ver, body string) fakeSource {
	t.Helper()
	a := archive(t, "factory", []byte(body))
	name := AssetName(ver, runtime.GOOS, runtime.GOARCH)
	return fakeSource{latest: ver, files: map[string][]byte{
		ver + "/" + name:       a,
		ver + "/checksums.txt": []byte(sum(a) + "  " + name + "\n"),
	}}
}

func runCommand(t *testing.T, current string, src Source, exe string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	cmd := NewCommand(current, src, exe)
	cmd.SetOut(&out)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func TestCommand(t *testing.T) {
	for _, tc := range []struct {
		name, current string
		args          []string
		wantOut       string
		wantBinary    string
	}{
		{"newer release replaces the binary", "v0.1.0", nil, "upgraded factory v0.1.0 to v0.2.0", "new"},
		{"current release changes nothing", "v0.2.0", nil, "factory v0.2.0 is current", "old"},
		{"check reports and changes nothing", "v0.1.0", []string{"--check"}, "factory v0.2.0 is available", "old"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			exe := filepath.Join(t.TempDir(), "factory")
			if err := os.WriteFile(exe, []byte("old"), 0o755); err != nil {
				t.Fatal(err)
			}
			out, err := runCommand(t, tc.current, releaseHere(t, "v0.2.0", "new"), exe, tc.args...)
			if err != nil || !strings.Contains(out, tc.wantOut) {
				t.Fatalf("out %q err %v", out, err)
			}
			if b, _ := os.ReadFile(exe); string(b) != tc.wantBinary {
				t.Fatalf("binary is %q, want %q", b, tc.wantBinary)
			}
		})
	}
}

func TestCommandBadChecksumKeepsTheBinary(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "factory")
	_ = os.WriteFile(exe, []byte("old"), 0o755)
	rel := releaseHere(t, "v0.2.0", "new")
	rel.files["v0.2.0/checksums.txt"] = []byte(strings.Repeat("0", 64) + "  " + AssetName("v0.2.0", runtime.GOOS, runtime.GOARCH) + "\n")
	if _, err := runCommand(t, "v0.1.0", rel, exe); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("got %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatalf("binary replaced: %q", b)
	}
}
