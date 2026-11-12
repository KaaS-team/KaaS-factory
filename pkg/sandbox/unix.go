//go:build linux || darwin

package sandbox

import (
	"fmt"
	"syscall"
)

func applyRlimits(limits []Rlimit) error {
	for _, l := range limits {
		res, ok := resource(l.Name)
		if !ok {
			return fmt.Errorf("sandbox: unknown rlimit %q", l.Name)
		}
		v := l.Value
		if err := syscall.Setrlimit(res, &syscall.Rlimit{Cur: v, Max: v}); err != nil {
			return fmt.Errorf("sandbox: rlimit %s: %w", l.Name, err)
		}
	}
	return nil
}

// resource maps a whitelisted rlimit name to this OS's resource number.
func resource(name string) (int, bool) {
	r, ok := map[string]int{"as": syscall.RLIMIT_AS, "core": syscall.RLIMIT_CORE, "cpu": syscall.RLIMIT_CPU,
		"data": syscall.RLIMIT_DATA, "fsize": syscall.RLIMIT_FSIZE, "nofile": syscall.RLIMIT_NOFILE,
		"nproc": rlimitNproc, "stack": syscall.RLIMIT_STACK}[name]
	return r, ok
}
