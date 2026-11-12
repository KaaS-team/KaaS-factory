package sandbox

import (
	"reflect"
	"testing"
)

// Symphony section 15 (safety): a missing control degrades loudly, not silently.
func TestMakePlan(t *testing.T) {
	full := Capabilities{Landlock: true, LandlockABI: 5, Rlimits: true}
	tests := []struct {
		name       string
		spec       Spec
		caps       Capabilities
		wantRules  bool
		wantDeny   bool
		wantLimits []Rlimit
		wantLines  []string
	}{
		{"full host, all limits", Spec{Workdir: "/w", Baseline: Limits{"as": 1, "cpu": 2, "nproc": 3}}, full, true, true,
			[]Rlimit{{"as", 1}, {"cpu", 2}, {"nproc", 3}},
			[]string{"landlock: enforced (abi 5)", "rlimits: applied", "network: denied"}},
		{"net allowed", Spec{Workdir: "/w", AllowNet: true, AllowHosts: []string{"a.example"}}, full, true, false, nil,
			[]string{"landlock: enforced (abi 5)", "rlimits: applied", "network: allowed", "allow-hosts: recorded only (a.example)"}},
		{"no landlock still applies rlimits", Spec{Baseline: Limits{"as": 9}}, Capabilities{Rlimits: true}, false, false,
			[]Rlimit{{"as", 9}},
			[]string{"landlock: unavailable", "rlimits: applied", "network: denied"}},
		{"nothing available", Spec{Baseline: Limits{"as": 9}}, Capabilities{}, false, false, nil,
			[]string{"landlock: unavailable", "rlimits: unavailable", "network: denied"}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			p := MakePlan(tt.spec, tt.caps)
			if (len(p.Landlock) > 0) != tt.wantRules {
				t.Fatalf("rules = %v", p.Landlock)
			}
			if p.DenyNet != tt.wantDeny {
				t.Fatalf("DenyNet = %v", p.DenyNet)
			}
			if !reflect.DeepEqual(p.Rlimits, tt.wantLimits) {
				t.Fatalf("rlimits = %v want %v", p.Rlimits, tt.wantLimits)
			}
			if !reflect.DeepEqual(p.Report.Lines, tt.wantLines) {
				t.Fatalf("report = %v", p.Report.Lines)
			}
		})
	}
}
