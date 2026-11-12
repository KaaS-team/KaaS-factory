// Package sandbox is a light per-session jail for agent processes: Landlock
// and rlimits on Linux, sandbox-exec on macOS. It needs no VM and no daemon.
//
// A jailed command is the current binary re-executed as a helper. The helper
// applies the restrictions and then execs the real program, so main must call
// MaybeEnter first.
package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
)

// helperEnv names the variable that carries the jail request to the helper.
const helperEnv = "KAAS_SANDBOX_HELPER"

// Spec describes the jail for one process.
type Spec struct {
	// Workdir is the working directory of the child and is always writable.
	Workdir string
	// ReadOnly paths may be read and executed.
	ReadOnly []string
	// ReadWrite paths may be read and written.
	ReadWrite []string
	// AllowNet permits network access; when false the jail denies it where the host can.
	AllowNet bool
	// AllowHosts is recorded in the report only; no host filtering is enforced.
	AllowHosts []string
	// MaxMemBytes is RLIMIT_AS; zero means no limit.
	MaxMemBytes uint64
	// MaxCPUSeconds is RLIMIT_CPU; zero means no limit.
	MaxCPUSeconds uint64
	// MaxProcs is RLIMIT_NPROC; zero means no limit.
	MaxProcs uint64
	// Backend selects the isolation: "" or "jail" for the helper below, "runsc" for gVisor
	// when a pinned runsc is installed; otherwise the jail runs.
	Backend string
	// Env is the only environment the child receives, as KEY=value entries.
	Env []string
}

// Capabilities says what this host can enforce.
type Capabilities struct {
	// Landlock is true when the kernel supports Landlock.
	Landlock bool
	// LandlockABI is the Landlock ABI version, zero when unavailable.
	LandlockABI int
	// SandboxExec is true when macOS sandbox-exec is installed.
	SandboxExec bool
	// Rlimits is true when resource limits can be applied.
	Rlimits bool
}

// request is what the parent hands the helper through helperEnv.
type request struct {
	Spec Spec     `json:"spec"`
	Argv []string `json:"argv"`
	// Caps replaces the host probe when set; tests use it to fake a host.
	Caps *Capabilities `json:"caps,omitempty"`
}

// Command returns a command that runs name with args under the jail described by spec.
// The command re-executes the current binary, whose main must call MaybeEnter first.
func Command(ctx context.Context, spec Spec, name string, args ...string) (*exec.Cmd, error) {
	return commandFor(ctx, spec, DefaultRunscPin, name, args...)
}

func jailCommand(ctx context.Context, spec Spec, name string, args ...string) (*exec.Cmd, error) {
	path, err := exec.LookPath(name)
	if err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	self, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	payload, err := json.Marshal(request{Spec: spec, Argv: append([]string{path}, args...)})
	if err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	cmd := exec.CommandContext(ctx, self)
	cmd.Dir = spec.Workdir
	cmd.Env = []string{helperEnv + "=" + string(payload)}
	return cmd, nil
}

// MaybeEnter must be the first call in main. When this process is a jail
// helper it applies the restrictions and execs the real program, and it only
// returns an error if that fails. In any other process it returns nil at once.
func MaybeEnter() error {
	raw, ok := os.LookupEnv(helperEnv)
	if !ok {
		return nil
	}
	var req request
	if err := json.Unmarshal([]byte(raw), &req); err != nil || len(req.Argv) == 0 {
		return errors.New("sandbox: bad helper request")
	}
	caps := Probe()
	if req.Caps != nil {
		caps = *req.Caps
	}
	return enter(req.Spec, req.Argv, caps)
}

// Report lists what the jail enforced for a spec on a host.
type Report struct {
	// Lines are "key: value" entries in a fixed order.
	Lines []string
}

// Has reports whether the report contains the exact line.
func (r Report) Has(line string) bool { return slices.Contains(r.Lines, line) }

// NewReport says what a jail for spec enforces on a host with caps.
func NewReport(spec Spec, caps Capabilities) Report {
	var l []string
	if caps.Landlock {
		l = append(l, fmt.Sprintf("landlock: enforced (abi %d)", caps.LandlockABI))
	} else {
		l = append(l, "landlock: unavailable")
	}
	if caps.Rlimits {
		l = append(l, "rlimits: applied")
	} else {
		l = append(l, "rlimits: unavailable")
	}
	if spec.AllowNet {
		l = append(l, "network: allowed")
	} else {
		l = append(l, "network: denied")
	}
	if len(spec.AllowHosts) > 0 {
		l = append(l, "allow-hosts: recorded only ("+strings.Join(spec.AllowHosts, ",")+")")
	}
	return Report{Lines: l}
}
