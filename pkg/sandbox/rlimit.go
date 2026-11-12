package sandbox

import (
	"fmt"
	"slices"
	"strings"
)

// Limits maps rlimit names to values. A zero value means no limit.
type Limits map[string]uint64

// limitNames is the whitelist of rlimit names, sorted.
var limitNames = []string{"as", "core", "cpu", "data", "fsize", "nofile", "nproc", "stack"}

// Validate fails for any rlimit name outside the whitelist, so a typo stops the session at start.
func (s Spec) Validate() error {
	for _, l := range []Limits{s.Baseline, s.Exec} {
		for n := range l {
			if !slices.Contains(limitNames, n) {
				return fmt.Errorf("sandbox: unknown rlimit %q (allowed: %s)", n, strings.Join(limitNames, ", "))
			}
		}
	}
	return nil
}

// mergeLimits applies exec over base by name and returns the non-zero limits sorted by name.
func mergeLimits(base, exec Limits) []Rlimit {
	var out []Rlimit
	for _, n := range limitNames {
		v, ok := exec[n]
		if !ok {
			v = base[n]
		}
		if v > 0 {
			out = append(out, Rlimit{n, v})
		}
	}
	return out
}
