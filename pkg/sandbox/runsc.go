package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// runscPathEnv names the variable that points at the runsc binary; empty means look on PATH.
const runscPathEnv = "KAAS_RUNSC"

// RunscPin pins the runsc binary the backend may run. Without a SHA256 the backend stays off.
type RunscPin struct {
	// Version is the gVisor release the sha256 belongs to, recorded for the operator.
	Version string
	// SHA256 is the hex digest of the runsc binary.
	SHA256 string
}

// DefaultRunscPin is the pin Command uses. It is empty until an operator pins a release,
// so the runsc backend falls back to the jail.
var DefaultRunscPin = RunscPin{}

func lookRunsc() (string, error) {
	if p := os.Getenv(runscPathEnv); p != "" {
		if _, err := os.Stat(p); err != nil {
			return "", err
		}
		return p, nil
	}
	return exec.LookPath("runsc")
}

// runscArgs is the runsc argv for a rootless, network-less run with an in-memory overlay.
func runscArgs(argv []string) []string {
	return append([]string{"--rootless", "--network=none", "--overlay2=all:memory", "do"}, argv...)
}

// chooseBackend says which backend runs: "runsc" only when asked for, present and matching the pin.
// Otherwise it returns "jail" and the reason runsc was not used, empty for the default.
func chooseBackend(backend, path string, pin RunscPin) (string, string) {
	switch backend {
	case "", "jail":
		return "jail", ""
	case "runsc":
	default:
		return "jail", fmt.Sprintf("unknown backend %q", backend)
	}
	if pin.SHA256 == "" {
		return "jail", "runsc has no pin"
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return "jail", "runsc unavailable: " + err.Error()
	}
	sum := sha256.Sum256(b)
	if !strings.EqualFold(hex.EncodeToString(sum[:]), pin.SHA256) {
		return "jail", "runsc sha256 does not match the pin"
	}
	return "runsc", ""
}

// commandFor builds the command for spec: runsc when selected and verified, else the jail helper.
func commandFor(ctx context.Context, spec Spec, pin RunscPin, name string, args ...string) (*exec.Cmd, error) {
	path, lerr := lookRunsc()
	if lerr != nil && spec.Backend == "runsc" {
		path = ""
	}
	if b, _ := chooseBackend(spec.Backend, path, pin); b == "runsc" {
		prog, err := exec.LookPath(name)
		if err != nil {
			return nil, fmt.Errorf("sandbox: %w", err)
		}
		cmd := exec.CommandContext(ctx, path, runscArgs(append([]string{prog}, args...))...)
		cmd.Dir, cmd.Env = spec.Workdir, spec.Env
		return cmd, nil
	}
	return jailCommand(ctx, spec, name, args...)
}
