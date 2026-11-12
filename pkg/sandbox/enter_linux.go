//go:build linux

package sandbox

import (
	"fmt"
	"os"
	"syscall"

	"github.com/landlock-lsm/go-landlock/landlock"
)

const rlimitNproc = 6 // RLIMIT_NPROC

// Probe reports what this host can enforce.
func Probe() Capabilities {
	// landlock_create_ruleset(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION)
	v, _, errno := syscall.Syscall(444, 0, 0, 1)
	c := Capabilities{Rlimits: true}
	if errno == 0 && int(v) > 0 {
		c.Landlock = true
		c.LandlockABI = int(v)
	}
	return c
}

func enter(spec Spec, argv []string, caps Capabilities) error {
	plan := MakePlan(spec, caps)
	if err := applyRlimits(plan.Rlimits); err != nil {
		return err
	}
	if plan.Landlock != nil {
		var rules []landlock.Rule
		for _, r := range plan.Landlock {
			rules = append(rules, fsRule(r))
		}
		if err := landlock.V5.BestEffort().RestrictPaths(rules...); err != nil {
			return fmt.Errorf("sandbox: landlock: %w", err)
		}
		if plan.DenyNet {
			if err := landlock.V5.BestEffort().RestrictNet(); err != nil {
				return fmt.Errorf("sandbox: landlock net: %w", err)
			}
		}
	}
	return syscall.Exec(argv[0], argv, spec.Env)
}

func fsRule(r FSRule) landlock.Rule {
	var rule landlock.FSRule
	if r.Access&AccessWriteFile != 0 {
		rule = landlock.RWDirs(r.Path)
	} else {
		rule = landlock.RODirs(r.Path)
	}
	if fi, err := os.Stat(r.Path); err == nil && !fi.IsDir() {
		if r.Access&AccessWriteFile != 0 {
			rule = landlock.RWFiles(r.Path)
		} else {
			rule = landlock.ROFiles(r.Path)
		}
	}
	return rule.IgnoreIfMissing()
}
