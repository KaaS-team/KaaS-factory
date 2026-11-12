//go:build darwin

package sandbox

import (
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"syscall"
)

const rlimitNproc = 7 // RLIMIT_NPROC

// sandboxExec is absolute because the helper runs with only the jail request in its
// environment: a PATH lookup there finds nothing, and the agent would run unjailed.
const sandboxExec = "/usr/bin/sandbox-exec"

// Probe reports what this host can enforce.
func Probe() Capabilities {
	_, err := os.Stat(sandboxExec)
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
	if _, err := os.Stat(sandboxExec); err != nil {
		return fmt.Errorf("sandbox: %w", err)
	}
	full := append([]string{"sandbox-exec", "-p", DarwinProfile(resolved(spec))}, argv...)
	return syscall.Exec(sandboxExec, full, spec.Env)
}

// resolved adds the symlink-free form of every writable path, because sandbox-exec matches
// real paths: /var/folders/... is /private/var/folders/... to the kernel.
func resolved(spec Spec) Spec {
	rw := slices.Clone(spec.ReadWrite)
	for _, p := range append([]string{spec.Workdir}, spec.ReadWrite...) {
		if r, err := filepath.EvalSymlinks(p); err == nil && r != filepath.Clean(p) {
			rw = append(rw, r)
		}
	}
	spec.ReadWrite = rw
	return spec
}
