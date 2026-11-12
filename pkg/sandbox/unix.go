//go:build linux || darwin

package sandbox

import (
	"fmt"
	"syscall"
)

func applyRlimits(limits []Rlimit) error {
	for _, l := range limits {
		var res int
		switch l.Name {
		case "as":
			res = syscall.RLIMIT_AS
		case "cpu":
			res = syscall.RLIMIT_CPU
		case "nproc":
			res = rlimitNproc
		default:
			return fmt.Errorf("sandbox: unknown rlimit %q", l.Name)
		}
		v := l.Value
		if err := syscall.Setrlimit(res, &syscall.Rlimit{Cur: v, Max: v}); err != nil {
			return fmt.Errorf("sandbox: rlimit %s: %w", l.Name, err)
		}
	}
	return nil
}
