//go:build !linux && !darwin

package sandbox

import "errors"

// Probe reports what this host can enforce; nothing on this platform.
func Probe() Capabilities { return Capabilities{} }

func enter(Spec, []string, Capabilities) error {
	return errors.New("sandbox: unsupported platform")
}
