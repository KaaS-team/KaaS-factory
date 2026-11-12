//go:build linux

package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if err := MaybeEnter(); err != nil {
		_, _ = os.Stderr.WriteString(err.Error() + "\n")
		os.Exit(97)
	}
	os.Exit(m.Run())
}

var systemRO = []string{"/usr", "/bin", "/lib", "/lib64", "/etc"}

func run(t *testing.T, spec Spec, name string, args ...string) (string, int) {
	t.Helper()
	cmd, err := Command(context.Background(), spec, name, args...)
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.CombinedOutput()
	var ee *exec.ExitError
	switch {
	case err == nil:
		return string(out), 0
	case errors.As(err, &ee):
		return string(out), ee.ExitCode()
	default:
		t.Fatal(err)
	}
	return "", -1
}

func TestEnvIsolation(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "x")
	t.Setenv("SECRET", "y")
	out, code := run(t, Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true, Env: []string{"KEEP=1"}}, "env")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	if strings.TrimSpace(out) != "KEEP=1" {
		t.Fatalf("child env = %q, want only KEEP=1", out)
	}
}

func TestLandlockWrites(t *testing.T) {
	if !Probe().Landlock {
		t.Skip("kernel has no Landlock")
	}
	rw, outside := t.TempDir(), t.TempDir()
	spec := Spec{Workdir: rw, ReadOnly: systemRO, AllowNet: true}
	if out, code := run(t, spec, "sh", "-c", "echo ok > "+filepath.Join(rw, "f")); code != 0 {
		t.Fatalf("write inside failed (%d): %s", code, out)
	}
	out, code := run(t, spec, "sh", "-c", "echo no > "+filepath.Join(outside, "f"))
	if code == 0 || !strings.Contains(out, "Permission denied") {
		t.Fatalf("write outside got code %d: %q", code, out)
	}
	if _, err := os.Stat(filepath.Join(outside, "f")); err == nil {
		t.Fatal("file was created outside")
	}
}

const alloc = "x = bytearray(300 * 1024 * 1024)"

func TestRlimitAS(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	spec := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true}
	if out, code := run(t, spec, "python3", "-c", alloc); code != 0 {
		t.Fatalf("control without a limit failed (%d): %s", code, out)
	}
	spec.Baseline = Limits{"as": 150 << 20}
	if out, code := run(t, spec, "python3", "-c", alloc); code == 0 {
		t.Fatalf("allocation past the as limit succeeded: %s", out)
	}
}

// Best effort: a host without Landlock still gets rlimits and says so.
func TestBestEffortWithoutLandlock(t *testing.T) {
	if _, err := exec.LookPath("python3"); err != nil {
		t.Skip("python3 not installed")
	}
	spec := Spec{Workdir: t.TempDir(), Baseline: Limits{"as": 150 << 20}, AllowNet: true}
	py, _ := exec.LookPath("python3")
	self, _ := os.Executable()
	caps := Capabilities{Rlimits: true}
	payload, _ := json.Marshal(request{Spec: spec, Argv: []string{py, "-c", alloc}, Caps: &caps})
	cmd := exec.Command(self)
	cmd.Env = []string{helperEnv + "=" + string(payload)}
	if err := cmd.Run(); err == nil {
		t.Fatal("rlimit was not applied without Landlock")
	}
	if !NewReport(spec, caps).Has("landlock: unavailable") {
		t.Fatal("report does not record landlock: unavailable")
	}
}

func TestMaxDurationKillsChild(t *testing.T) {
	spec := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true, Policy: Policy{MaxDuration: 300 * time.Millisecond}}
	start := time.Now()
	if _, code := run(t, spec, "sleep", "30"); code == 0 || time.Since(start) > 10*time.Second {
		t.Fatalf("child not stopped at MaxDuration (exit %d after %v)", code, time.Since(start))
	}
}
