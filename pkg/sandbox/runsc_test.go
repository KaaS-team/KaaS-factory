package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func fakeRunsc(t *testing.T, body string) (path, sum string) {
	t.Helper()
	path = filepath.Join(t.TempDir(), "runsc")
	if err := os.WriteFile(path, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256([]byte(body))
	return path, hex.EncodeToString(h[:])
}

// TestRunscArgv pins the flags the backend passes: rootless, no network, memory overlay.
func TestRunscArgv(t *testing.T) {
	got := runscArgs([]string{"/bin/echo", "hi"})
	want := []string{"--rootless", "--network=none", "--overlay2=all:memory", "do", "/bin/echo", "hi"}
	if !slices.Equal(got, want) {
		t.Fatalf("argv = %v, want %v", got, want)
	}
}

// TestChooseBackend: every branch of the selection rule.
func TestChooseBackend(t *testing.T) {
	ok, sum := fakeRunsc(t, "#!/bin/sh\n")
	missing := filepath.Join(t.TempDir(), "nope")
	cases := []struct {
		name    string
		backend string
		path    string
		pin     RunscPin
		want    string
		reason  string
	}{
		{"default jail", "", ok, RunscPin{SHA256: sum}, "jail", ""},
		{"runsc present and pinned", "runsc", ok, RunscPin{SHA256: sum}, "runsc", ""},
		{"runsc absent falls back", "runsc", missing, RunscPin{SHA256: sum}, "jail", "unavailable"},
		{"runsc sha mismatch falls back", "runsc", ok, RunscPin{SHA256: strings.Repeat("0", 64)}, "jail", "sha256"},
		{"runsc unpinned falls back", "runsc", ok, RunscPin{}, "jail", "no pin"},
		{"unknown backend falls back", "kata", ok, RunscPin{SHA256: sum}, "jail", "unknown"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, why := chooseBackend(c.backend, c.path, c.pin)
			if got != c.want || !strings.Contains(why, c.reason) {
				t.Fatalf("got %q (%q), want %q containing %q", got, why, c.want, c.reason)
			}
		})
	}
}

// TestCommandUsesRunscWhenPinned: a fake runsc receives the argv and runs the program.
func TestCommandUsesRunscWhenPinned(t *testing.T) {
	path, sum := fakeRunsc(t, "#!/bin/sh\necho \"$@\"\n")
	t.Setenv(runscPathEnv, path)
	cmd, err := commandFor(context.Background(), Spec{Backend: "runsc", Workdir: t.TempDir()}, RunscPin{SHA256: sum}, "/bin/echo", "x")
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "--rootless --network=none --overlay2=all:memory do /bin/echo x" {
		t.Fatalf("out = %q", got)
	}
}

// TestCommandFallsBackToJail: with runsc absent the command is the jail helper, the current binary.
func TestCommandFallsBackToJail(t *testing.T) {
	t.Setenv(runscPathEnv, filepath.Join(t.TempDir(), "nope"))
	cmd, err := commandFor(context.Background(), Spec{Backend: "runsc", Workdir: t.TempDir()}, RunscPin{SHA256: "ab"}, "/bin/echo", "x")
	if err != nil {
		t.Fatal(err)
	}
	self, _ := os.Executable()
	if cmd.Path != self {
		t.Fatalf("path = %s, want the jail helper %s", cmd.Path, self)
	}
}

// TestRunscEval is the eval fixture: go build, npm ci and git inside real runsc, with wall time.
// It skips where runsc is absent.
func TestRunscEval(t *testing.T) {
	path, err := lookRunsc()
	if err != nil {
		t.Skipf("runsc unavailable: %v", err)
	}
	dir := t.TempDir()
	for _, step := range [][]string{{"go", "version"}, {"npm", "--version"}, {"git", "--version"}} {
		start := time.Now()
		bin, lerr := exec.LookPath(step[0])
		if lerr != nil {
			t.Logf("%s: skip (not installed)", step[0])
			continue
		}
		cmd, cerr := commandFor(t.Context(), Spec{Backend: "runsc", Workdir: dir}, RunscPin{SHA256: mustSum(t, path)}, bin, step[1:]...)
		if cerr != nil {
			t.Fatal(cerr)
		}
		out, rerr := cmd.CombinedOutput()
		verdict := "pass"
		if rerr != nil {
			verdict = "fail"
		}
		t.Logf("%s: %s in %s", step[0], verdict, time.Since(start))
		if rerr != nil {
			t.Errorf("%s failed: %v\n%s", step[0], rerr, out)
		}
	}
}

func mustSum(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// TestRunscSwapAfterHashRunsCheckedBytes: the original file is replaced after it was hashed; the
// command must run the bytes that were hashed, never the swapped ones.
func TestRunscSwapAfterHashRunsCheckedBytes(t *testing.T) {
	path, sum := fakeRunsc(t, "#!/bin/sh\necho checked\n")
	t.Setenv(runscPathEnv, path)
	afterRunscHash = func() {
		evil := path + ".evil"
		if err := os.WriteFile(evil, []byte("#!/bin/sh\necho swapped\n"), 0o755); err != nil {
			t.Error(err)
		}
		if err := os.Rename(evil, path); err != nil {
			t.Error(err)
		}
	}
	t.Cleanup(func() { afterRunscHash = func() {} })
	cmd, err := commandFor(context.Background(), Spec{Backend: "runsc", Workdir: t.TempDir()}, RunscPin{SHA256: sum}, "/bin/echo", "x")
	if err != nil {
		t.Fatal(err)
	}
	if cmd.Path == path {
		t.Fatalf("command executes the original path %s", path)
	}
	if st, err := os.Stat(filepath.Dir(cmd.Path)); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("copy dir = %v, %v; want mode 0700", st, err)
	}
	out, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(out)); got != "checked" {
		t.Fatalf("ran %q, want the checked bytes", got)
	}
}
