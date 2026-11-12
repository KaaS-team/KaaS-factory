package sandbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
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
	b, _, why := chooseRunsc(backend, path, pin)
	return b, why
}

// chooseRunsc is chooseBackend plus the path to execute. For runsc that path is a private copy of
// the bytes that were hashed, never the original path, which could be swapped after the check.
func chooseRunsc(backend, path string, pin RunscPin) (string, string, string) {
	switch backend {
	case "", "jail":
		return "jail", "", ""
	case "runsc":
	default:
		return "jail", "", fmt.Sprintf("unknown backend %q", backend)
	}
	if pin.SHA256 == "" {
		return "jail", "", "runsc has no pin"
	}
	staged, sum, err := stageRunsc(path, pin)
	if err != nil {
		return "jail", "", "runsc unavailable: " + err.Error()
	}
	if !strings.EqualFold(sum, pin.SHA256) {
		return "jail", "", "runsc sha256 does not match the pin"
	}
	return "runsc", staged, ""
}

// afterRunscHash runs once the binary was copied and hashed and before it is used; tests swap the
// original file here to prove the swap cannot reach the exec.
var afterRunscHash = func() {}

var (
	stagedMu sync.Mutex
	// staged maps a digest to the private copy that hashes to it, so a run does not copy the
	// binary again. The copy sits in a 0700 directory this process made, so it is not swapped.
	staged = map[string]string{}
)

// stageRunsc copies the binary at path into a fresh private 0700 directory while hashing the same
// stream, so the digest describes exactly the bytes that will run. It returns the copy and the
// hex digest; a copy whose digest differs from the pin is removed.
func stageRunsc(path string, pin RunscPin) (string, string, error) {
	stagedMu.Lock()
	defer stagedMu.Unlock()
	src, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = src.Close() }()
	dir, err := os.MkdirTemp("", "kaas-runsc-")
	if err != nil {
		return "", "", err
	}
	dst := filepath.Join(dir, "runsc")
	fail := func(err error) (string, string, error) { _ = os.RemoveAll(dir); return "", "", err }
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o700)
	if err != nil {
		return fail(err)
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(out, h), src)
	if cerr := out.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return fail(err)
	}
	sum := hex.EncodeToString(h.Sum(nil))
	afterRunscHash()
	if !strings.EqualFold(sum, pin.SHA256) {
		_ = os.RemoveAll(dir)
		return "", sum, nil
	}
	if old, ok := staged[sum]; ok {
		if _, err := os.Stat(old); err == nil {
			_ = os.RemoveAll(dir)
			return old, sum, nil
		}
	}
	staged[sum] = dst
	return dst, sum, nil
}

// commandFor builds the command for spec: runsc when selected and verified, else the jail helper.
func commandFor(ctx context.Context, spec Spec, pin RunscPin, name string, args ...string) (*exec.Cmd, error) {
	// Both backends stop the child at MaxDuration. The timer frees itself then; cancel also runs
	// if the caller's ctx ends first or the command cannot be built.
	cancel := func() {}
	if spec.Policy.MaxDuration > 0 {
		ctx, cancel = context.WithTimeout(ctx, spec.Policy.MaxDuration)
	}
	cmd, err := backendCommand(ctx, spec, pin, name, args...)
	if err != nil {
		cancel()
		return nil, err
	}
	kill := cmd.Cancel
	cmd.Cancel = func() error { cancel(); return kill() }
	return cmd, nil
}

func backendCommand(ctx context.Context, spec Spec, pin RunscPin, name string, args ...string) (*exec.Cmd, error) {
	path, lerr := lookRunsc()
	if lerr != nil && spec.Backend == "runsc" {
		path = ""
	}
	if b, runsc, _ := chooseRunsc(spec.Backend, path, pin); b == "runsc" {
		prog, err := exec.LookPath(name)
		if err != nil {
			return nil, fmt.Errorf("sandbox: %w", err)
		}
		cmd := exec.CommandContext(ctx, runsc, runscArgs(append([]string{prog}, args...))...)
		cmd.Dir, cmd.Env = spec.Workdir, spec.Env
		return cmd, nil
	}
	return jailCommand(ctx, spec, name, args...)
}
