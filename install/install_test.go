package install

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

const fakeBinary = "#!/bin/sh\necho factory-fake 1.2.3\n"

// archive builds a tar.gz holding one executable named factory.
func archive(t *testing.T, body string) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "factory", Mode: 0o755, Size: int64(len(body))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(body)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

// serve starts a release server. Checksums are computed over good, the archive served is served.
func serve(t *testing.T, name string, good, served []byte, paths *[]string) string {
	t.Helper()
	sum := sha256.Sum256(good)
	sums := fmt.Sprintf("%s  %s\n%s  other.tar.gz\n", hex.EncodeToString(sum[:]), name, strings.Repeat("0", 64))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*paths = append(*paths, r.URL.Path)
		switch {
		case strings.HasSuffix(r.URL.Path, "/checksums.txt"):
			_, _ = w.Write([]byte(sums))
		case strings.HasSuffix(r.URL.Path, "/"+name):
			_, _ = w.Write(served)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func run(t *testing.T, base, binDir string, extra ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("sh", "install.sh")
	cmd.Env = append([]string{
		"PATH=/usr/bin:/bin",
		"HOME=" + t.TempDir(),
		"FACTORY_BASE_URL=" + base,
		"FACTORY_BIN_DIR=" + binDir,
		"FACTORY_UNAME_S=Linux",
		"FACTORY_UNAME_M=x86_64",
	}, extra...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestInstallsFakeBinaryAndItRuns(t *testing.T) {
	a := archive(t, fakeBinary)
	var paths []string
	base := serve(t, "factory_linux_amd64.tar.gz", a, a, &paths)
	bin := filepath.Join(t.TempDir(), "bin")
	out, err := run(t, base, bin)
	if err != nil {
		t.Fatalf("install failed: %v\n%s", err, out)
	}
	got, err := exec.Command(filepath.Join(bin, "factory")).Output()
	if err != nil || !strings.Contains(string(got), "factory-fake") {
		t.Fatalf("installed binary did not run: %v %q", err, got)
	}
	if !strings.Contains(out, "factory doctor") {
		t.Fatalf("next command not printed:\n%s", out)
	}
	if !strings.Contains(strings.Join(paths, " "), "/releases/latest/download/") {
		t.Fatalf("default is not latest release: %v", paths)
	}
}

func TestPinnedVersionUsesTaggedRelease(t *testing.T) {
	a := archive(t, fakeBinary)
	var paths []string
	base := serve(t, "factory_linux_amd64.tar.gz", a, a, &paths)
	if out, err := run(t, base, t.TempDir(), "FACTORY_VERSION=v9.1.0"); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if !strings.Contains(strings.Join(paths, " "), "/releases/download/v9.1.0/") {
		t.Fatalf("tag not used: %v", paths)
	}
}

func TestTamperedArchiveFailsChecksumAndInstallsNothing(t *testing.T) {
	good := archive(t, fakeBinary)
	bad := archive(t, "#!/bin/sh\necho evil\n")
	var paths []string
	base := serve(t, "factory_linux_amd64.tar.gz", good, bad, &paths)
	bin := filepath.Join(t.TempDir(), "bin")
	out, err := run(t, base, bin)
	if err == nil {
		t.Fatalf("tampered archive installed:\n%s", out)
	}
	if !strings.Contains(out, "checksum") {
		t.Fatalf("error does not name the checksum:\n%s", out)
	}
	if _, statErr := os.Stat(filepath.Join(bin, "factory")); statErr == nil {
		t.Fatal("binary was installed despite checksum failure")
	}
}

func TestPlatformDetection(t *testing.T) {
	cases := []struct {
		name, s, m, asset string
		ok                bool
	}{
		{"linux amd64", "Linux", "x86_64", "factory_linux_amd64.tar.gz", true},
		{"linux arm64", "Linux", "aarch64", "factory_linux_arm64.tar.gz", true},
		{"darwin arm64", "Darwin", "arm64", "factory_darwin_arm64.tar.gz", true},
		{"darwin amd64", "Darwin", "x86_64", "factory_darwin_amd64.tar.gz", true},
		{"unsupported os", "FreeBSD", "x86_64", "", false},
		{"unsupported arch", "Linux", "riscv64", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			a := archive(t, fakeBinary)
			var paths []string
			name := c.asset
			if name == "" {
				name = "factory_linux_amd64.tar.gz"
			}
			base := serve(t, name, a, a, &paths)
			bin := filepath.Join(t.TempDir(), "bin")
			out, err := run(t, base, bin, "FACTORY_UNAME_S="+c.s, "FACTORY_UNAME_M="+c.m)
			if c.ok != (err == nil) {
				t.Fatalf("ok=%v err=%v\n%s", c.ok, err, out)
			}
			if c.ok && !strings.Contains(strings.Join(paths, " "), c.asset) {
				t.Fatalf("wrong asset requested: %v", paths)
			}
			if !c.ok && !strings.Contains(out, "unsupported") {
				t.Fatalf("no unsupported message:\n%s", out)
			}
		})
	}
}

func TestMissingArchiveFailsCleanly(t *testing.T) {
	a := archive(t, fakeBinary)
	var paths []string
	base := serve(t, "factory_linux_arm64.tar.gz", a, a, &paths) // amd64 asked, not served
	bin := filepath.Join(t.TempDir(), "bin")
	if out, err := run(t, base, bin); err == nil {
		t.Fatalf("expected failure:\n%s", out)
	}
	if _, err := os.Stat(filepath.Join(bin, "factory")); err == nil {
		t.Fatal("binary installed after failed download")
	}
}

// runArgs runs install.sh with flags, without FACTORY_BIN_DIR or FACTORY_VERSION set.
func runArgs(t *testing.T, base string, args ...string) (string, error) {
	t.Helper()
	cmd := exec.Command("sh", append([]string{"install.sh"}, args...)...)
	cmd.Env = []string{
		"PATH=/usr/bin:/bin",
		"HOME=" + t.TempDir(),
		"FACTORY_BASE_URL=" + base,
		"FACTORY_UNAME_S=Linux",
		"FACTORY_UNAME_M=x86_64",
	}
	out, err := cmd.CombinedOutput()
	return string(out), err
}

func TestVersionFlagPinsTagAndAcceptsBareNumber(t *testing.T) {
	for _, tag := range []string{"v9.1.0", "9.1.0"} {
		t.Run(tag, func(t *testing.T) {
			a := archive(t, fakeBinary)
			var paths []string
			base := serve(t, "factory_linux_amd64.tar.gz", a, a, &paths)
			bin := filepath.Join(t.TempDir(), "bin")
			if out, err := runArgs(t, base, "--version", tag, "--dir", bin); err != nil {
				t.Fatalf("%v\n%s", err, out)
			}
			if !strings.Contains(strings.Join(paths, " "), "/releases/download/v9.1.0/") {
				t.Fatalf("tag not used: %v", paths)
			}
		})
	}
}

func TestDirFlagInstallsThereAndStillVerifiesChecksum(t *testing.T) {
	good := archive(t, fakeBinary)
	bad := archive(t, "#!/bin/sh\necho evil\n")
	var paths []string
	base := serve(t, "factory_linux_amd64.tar.gz", good, bad, &paths)
	bin := filepath.Join(t.TempDir(), "x")
	out, err := runArgs(t, base, "--dir", bin)
	if err == nil || !strings.Contains(out, "checksum") {
		t.Fatalf("tampered archive not refused: %v\n%s", err, out)
	}
	if _, statErr := os.Stat(filepath.Join(bin, "factory")); statErr == nil {
		t.Fatal("installed despite checksum failure")
	}
}

func TestUninstallRemovesOnlyTheBinary(t *testing.T) {
	bin := t.TempDir()
	keep := filepath.Join(bin, "other")
	if err := os.WriteFile(keep, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "factory"), []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	out, err := runArgs(t, "http://127.0.0.1:1", "--uninstall", "--dir", bin)
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	if _, e := os.Stat(filepath.Join(bin, "factory")); e == nil {
		t.Fatal("factory still there")
	}
	if _, e := os.Stat(keep); e != nil {
		t.Fatal("uninstall removed another file")
	}
}

func TestFlagErrorsAndHelp(t *testing.T) {
	cases := []struct {
		name string
		args []string
		ok   bool
		want string
	}{
		{"help", []string{"--help"}, true, "Usage: install.sh"},
		{"short help", []string{"-h"}, true, "--uninstall"},
		{"version needs value", []string{"--version"}, false, "--version needs a tag"},
		{"dir needs value", []string{"--dir"}, false, "--dir needs a path"},
		{"unknown flag", []string{"--bogus"}, false, "unknown option: --bogus"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out, err := runArgs(t, "http://127.0.0.1:1", c.args...)
			if c.ok != (err == nil) {
				t.Fatalf("ok=%v err=%v\n%s", c.ok, err, out)
			}
			if !strings.Contains(out, c.want) {
				t.Fatalf("missing %q:\n%s", c.want, out)
			}
		})
	}
}

// TestPrefixInstallsUnderPrefixBin: PREFIX selects $PREFIX/bin when no dir flag or FACTORY_BIN_DIR is set.
func TestPrefixInstallsUnderPrefixBin(t *testing.T) {
	a := archive(t, fakeBinary)
	var paths []string
	base := serve(t, "factory_linux_amd64.tar.gz", a, a, &paths)
	prefix := t.TempDir()
	out, err := run(t, base, "", "PREFIX="+prefix)
	if err != nil {
		t.Fatalf("install failed: %v\n%s", err, out)
	}
	if _, err := os.Stat(filepath.Join(prefix, "bin", "factory")); err != nil {
		t.Fatalf("not installed under PREFIX/bin: %v\n%s", err, out)
	}
}

// TestInstallsFromPythonHTTPServer: the script works against a plain static file server serving a fake release.
func TestInstallsFromPythonHTTPServer(t *testing.T) {
	py, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 not installed")
	}
	root := t.TempDir()
	dir := filepath.Join(root, "releases", "latest", "download")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	a := archive(t, fakeBinary)
	sum := sha256.Sum256(a)
	name := "factory_linux_amd64.tar.gz"
	if err := os.WriteFile(filepath.Join(dir, name), a, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "checksums.txt"), []byte(hex.EncodeToString(sum[:])+"  "+name+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	srv := exec.CommandContext(ctx, py, "-m", "http.server", fmt.Sprint(port), "--bind", "127.0.0.1", "--directory", root)
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { cancel(); _ = srv.Wait() }()
	base := fmt.Sprintf("http://127.0.0.1:%d", port)
	for i := 0; i < 100; i++ {
		if r, err := http.Get(base + "/"); err == nil {
			_ = r.Body.Close()
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	binDir := t.TempDir()
	out, err := run(t, base, binDir)
	if err != nil {
		t.Fatalf("install failed: %v\n%s", err, out)
	}
	got, err := exec.Command(filepath.Join(binDir, "factory")).Output()
	if err != nil || !strings.Contains(string(got), "factory-fake") {
		t.Fatalf("installed binary did not run: %v %q", err, got)
	}
}
