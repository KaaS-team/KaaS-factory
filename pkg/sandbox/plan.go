package sandbox

// Rlimit is one resource limit the helper sets before exec.
type Rlimit struct {
	Name  string
	Value uint64
}

// Plan is what the helper applies for a spec on a host.
type Plan struct {
	// Landlock is the rule set, nil when the host has no Landlock.
	Landlock []FSRule
	// DenyNet is true when Landlock should also block TCP.
	DenyNet bool
	// Rlimits are the limits to set, in a fixed order.
	Rlimits []Rlimit
	// Report records what was and was not enforced.
	Report Report
}

// MakePlan is the pure decision of what to enforce. Missing Landlock does not
// stop the rlimits: the plan is best effort and the report says what is absent.
func MakePlan(spec Spec, caps Capabilities) Plan {
	p := Plan{Report: NewReport(spec, caps)}
	if caps.Landlock {
		p.Landlock = LandlockRules(spec)
		p.DenyNet = !spec.AllowNet
	}
	if caps.Rlimits {
		p.Rlimits = limitSet(spec)
	}
	return p
}
