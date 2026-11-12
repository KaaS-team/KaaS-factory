//go:build linux

package sandbox

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"syscall"
	"testing"
)

// Symphony section 15 (safety): an unknown limit name fails at session start, never silently.
func TestValidateLimits(t *testing.T) {
	tests := []struct {
		name    string
		spec    Spec
		wantErr string
	}{
		{"empty", Spec{}, ""},
		{"every whitelisted name", Spec{Baseline: Limits{"as": 1, "core": 1, "cpu": 1, "data": 1, "fsize": 1, "nofile": 1, "nproc": 1, "stack": 1}}, ""},
		{"unknown in baseline", Spec{Baseline: Limits{"bogus": 1}}, `unknown rlimit "bogus"`},
		{"unknown in exec", Spec{Exec: Limits{"RLIMIT_AS": 1}}, `unknown rlimit "RLIMIT_AS"`},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := tt.spec.Validate()
			if tt.wantErr == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) || !strings.Contains(err.Error(), "allowed:") {
				t.Fatalf("err = %v, want %q and the allowed names", err, tt.wantErr)
			}
		})
	}
}

func TestCommandRejectsUnknownLimit(t *testing.T) {
	_, err := Command(t.Context(), Spec{Workdir: t.TempDir(), Baseline: Limits{"bogus": 1}}, "true")
	if err == nil || !strings.Contains(err.Error(), `unknown rlimit "bogus"`) {
		t.Fatalf("Command err = %v", err)
	}
}

func TestMergeLimits(t *testing.T) {
	tests := []struct {
		name       string
		base, exec Limits
		want       []Rlimit
	}{
		{"baseline only", Limits{"nofile": 64, "as": 9}, nil, []Rlimit{{"as", 9}, {"nofile", 64}}},
		{"exec overrides", Limits{"nofile": 64}, Limits{"nofile": 32}, []Rlimit{{"nofile", 32}}},
		{"exec adds", Limits{"nofile": 64}, Limits{"cpu": 5}, []Rlimit{{"cpu", 5}, {"nofile", 64}}},
		{"zero lifts a baseline limit", Limits{"nofile": 64}, Limits{"nofile": 0}, nil},
		{"zero in baseline is unset", Limits{"nofile": 0}, nil, nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := mergeLimits(tt.base, tt.exec); !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %v want %v", got, tt.want)
			}
		})
	}
}

func TestEveryNameHasAResource(t *testing.T) {
	for _, n := range limitNames {
		if _, ok := resource(n); !ok {
			t.Errorf("%q is whitelisted but has no resource", n)
		}
	}
}

func ulimit(t *testing.T, spec Spec, script string) string {
	t.Helper()
	spec.Workdir, spec.ReadOnly, spec.AllowNet = t.TempDir(), []string{"/"}, true
	out, code := run(t, spec, "sh", "-c", script)
	if code != 0 {
		t.Fatalf("exit %d: %s", code, out)
	}
	return strings.TrimSpace(out)
}

func TestBaselineInheritedAndExecOverrides(t *testing.T) {
	tests := []struct {
		name   string
		spec   Spec
		script string
		want   string
	}{
		{"baseline reaches the process", Spec{Baseline: Limits{"nofile": 64}}, "ulimit -n", "64"},
		{"a grandchild inherits it", Spec{Baseline: Limits{"nofile": 64}}, `sh -c "ulimit -n"`, "64"},
		{"exec override wins", Spec{Baseline: Limits{"nofile": 64}, Exec: Limits{"nofile": 32}}, "ulimit -n", "32"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ulimit(t, tt.spec, tt.script); got != tt.want {
				t.Fatalf("got %q want %q", got, tt.want)
			}
		})
	}
}

// asNobody runs script under the helper as uid 65534 with limits as the baseline. RLIMIT_NPROC is
// not enforced for root, and nobody cannot read the test binary, so the binary is copied first.
func asNobody(t *testing.T, limits Limits, script string) error {
	t.Helper()
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin, err := os.ReadFile(self)
	if err != nil {
		t.Fatal(err)
	}
	dir, err := os.MkdirTemp("", "nproc")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	copied := filepath.Join(dir, "helper")
	if err := os.Chmod(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copied, bin, 0o755); err != nil {
		t.Fatal(err)
	}
	sh, _ := exec.LookPath("sh")
	payload, _ := json.Marshal(request{Spec: Spec{Baseline: limits}, Argv: []string{sh, "-c", script}, Caps: &Capabilities{Rlimits: true}})
	cmd := exec.Command(copied)
	cmd.Dir = "/"
	cmd.Env = []string{helperEnv + "=" + string(payload)}
	cmd.SysProcAttr = &syscall.SysProcAttr{Credential: &syscall.Credential{Uid: 65534, Gid: 65534}}
	out, err := cmd.CombinedOutput()
	t.Logf("%s", out)
	return err
}

func TestRlimitNproc(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("needs root to drop to an unprivileged uid")
	}
	if err := asNobody(t, nil, "true & wait"); err != nil {
		t.Fatalf("control without a limit failed: %v", err)
	}
	var ee *exec.ExitError
	if err := asNobody(t, Limits{"nproc": 1}, "true & wait"); !errors.As(err, &ee) {
		t.Fatalf("fork past nproc: err = %v, want a nonzero exit", err)
	}
}

// TestAuditTable pins the audit's present rows to code that exists.
func TestAuditTable(t *testing.T) {
	doc, err := os.ReadFile("AUDIT.md")
	if err != nil {
		t.Fatal(err)
	}
	for _, ctl := range []string{"pid namespace", "mount namespace", "net namespace", "pivot_root", "uid drop", "cgroup v2 limits", "rlimits", "seccomp"} {
		if !regexp.MustCompile(`(?m)^\| ` + ctl + ` \| (present|absent) \|`).Match(doc) {
			t.Errorf("AUDIT.md has no present/absent row for %q", ctl)
		}
	}
	if !strings.Contains(string(doc), "| rlimits | present |") || len(limitNames) == 0 {
		t.Error("rlimits must be marked present while the whitelist exists")
	}
}
