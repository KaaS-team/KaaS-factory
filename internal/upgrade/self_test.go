package upgrade

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/selfupdate"
)

// fakeRelease is a release source with one archive; no network.
type fakeRelease struct {
	version string
	files   map[string][]byte
}

func (f fakeRelease) Latest(context.Context) (selfupdate.Release, error) {
	return selfupdate.Release{Version: f.version}, nil
}

func (f fakeRelease) Asset(_ context.Context, _, name string) ([]byte, error) {
	b, ok := f.files[name]
	if !ok {
		return nil, fmt.Errorf("no asset %s", name)
	}
	return b, nil
}

func release(t *testing.T, version, body string) fakeRelease {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "factory", Mode: 0o755, Size: int64(len(body)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	_, _ = tw.Write([]byte(body))
	_ = tw.Close()
	_ = gz.Close()
	name := selfupdate.AssetName(version, runtime.GOOS, runtime.GOARCH)
	sum := sha256.Sum256(buf.Bytes())
	return fakeRelease{version: version, files: map[string][]byte{
		name:            buf.Bytes(),
		"checksums.txt": []byte(hex.EncodeToString(sum[:]) + "  " + name + "\n"),
	}}
}

func runSelf(t *testing.T, current string, src selfupdate.Source, exe string, args ...string) (string, error) {
	t.Helper()
	var out bytes.Buffer
	cmd := NewSelfCommand(current, src, exe)
	cmd.SetOut(&out)
	cmd.SetArgs(args)
	err := cmd.Execute()
	return out.String(), err
}

func TestSelfUpgrade(t *testing.T) {
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
			out, err := runSelf(t, tc.current, release(t, "v0.2.0", "new"), exe, tc.args...)
			if err != nil || !strings.Contains(out, tc.wantOut) {
				t.Fatalf("out %q err %v", out, err)
			}
			if b, _ := os.ReadFile(exe); string(b) != tc.wantBinary {
				t.Fatalf("binary is %q, want %q", b, tc.wantBinary)
			}
		})
	}
}

func TestSelfUpgrade_BadChecksumKeepsTheBinary(t *testing.T) {
	exe := filepath.Join(t.TempDir(), "factory")
	_ = os.WriteFile(exe, []byte("old"), 0o755)
	rel := release(t, "v0.2.0", "new")
	rel.files["checksums.txt"] = []byte(strings.Repeat("0", 64) + "  " + selfupdate.AssetName("v0.2.0", runtime.GOOS, runtime.GOARCH) + "\n")
	if _, err := runSelf(t, "v0.1.0", rel, exe); err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("got %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Fatalf("binary replaced: %q", b)
	}
}
