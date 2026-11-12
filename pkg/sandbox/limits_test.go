package sandbox

import (
	"os"
	"reflect"
	"strings"
	"testing"
)

func TestValidateLimits(t *testing.T) {
	tests := []struct {
		name string
		spec Spec
		bad  string
	}{
		{"none", Spec{}, ""},
		{"whitelisted baseline", Spec{Limits: map[string]uint64{"nofile": 64}}, ""},
		{"unknown baseline", Spec{Limits: map[string]uint64{"memlock2": 1}}, "memlock2"},
		{"unknown override", Spec{ExecLimits: map[string]uint64{"bogus": 1}}, "bogus"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := ValidateLimits(tc.spec)
			if (err == nil) != (tc.bad == "") || (err != nil && !strings.Contains(err.Error(), tc.bad)) {
				t.Fatalf("err = %v, want mention of %q", err, tc.bad)
			}
		})
	}
}

func TestCommandRejectsUnknownLimit(t *testing.T) {
	if _, err := Command(t.Context(), Spec{Limits: map[string]uint64{"bogus": 1}}, "true"); err == nil {
		t.Fatal("Command accepted an unknown rlimit name")
	}
}

func TestMakePlanLayers(t *testing.T) {
	spec := Spec{MaxProcs: 3, Limits: map[string]uint64{"nofile": 64, "nproc": 9}, ExecLimits: map[string]uint64{"nofile": 32}}
	got := MakePlan(spec, Capabilities{Rlimits: true}).Rlimits
	want := []Rlimit{{"nofile", 32}, {"nproc", 9}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("rlimits = %v, want %v (exec over baseline over legacy fields)", got, want)
	}
}

func TestRlimitNproc(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root bypasses RLIMIT_NPROC")
	}
	spec := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true, Limits: map[string]uint64{"nproc": 1}}
	if out, code := run(t, spec, "sh", "-c", "true & wait"); code == 0 {
		t.Fatalf("fork past nproc succeeded: %s", out)
	}
}

func TestBaselineInheritedAndOverridden(t *testing.T) {
	base := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true, Limits: map[string]uint64{"nofile": 64}}
	if out, code := run(t, base, "sh", "-c", "ulimit -n"); code != 0 || strings.TrimSpace(out) != "64" {
		t.Fatalf("child nofile = %q (exit %d), want baseline 64", out, code)
	}
	base.ExecLimits = map[string]uint64{"nofile": 32}
	if out, _ := run(t, base, "sh", "-c", "ulimit -n"); strings.TrimSpace(out) != "32" {
		t.Fatalf("child nofile = %q, want override 32", out)
	}
}

func TestRlimitASFromLimits(t *testing.T) {
	spec := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true, Limits: map[string]uint64{"as": 150 << 20}}
	if out, code := run(t, spec, "python3", "-c", alloc); code == 0 {
		t.Fatalf("allocation past Limits[as] succeeded: %s", out)
	}
}
