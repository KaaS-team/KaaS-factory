//go:build darwin

package sandbox

import (
	"fmt"
	"os/exec"
	"syscall"
)

const rlimitNproc = 7 // RLIMIT_NPROC

// Probe reports what this host can enforce.
func Probe() Capabilities {
	_, err := exec.LookPath("sandbox-exec")
	return Capabilities{SandboxExec: err == nil, Rlimits: true}
}

func enter(spec Spec, argv []string, caps Capabilities) error {
	plan := MakePlan(spec, caps)
	if err := applyRlimits(plan.Rlimits); err != nil {
		return err
	}
	if !caps.SandboxExec {
		return syscall.Exec(argv[0], argv, spec.Env)
	}
	se, err := exec.LookPath("sandbox-exec")
	if err != nil {
		return fmt.Errorf("sandbox: %w", err)
	}
	full := append([]string{"sandbox-exec", "-p", DarwinProfile(spec)}, argv...)
	return syscall.Exec(se, full, spec.Env)
}
