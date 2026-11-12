package sarif

import (
	"strings"
	"testing"
)

func TestParseAnnotations(t *testing.T) {
	tests := []struct {
		name, in, wantErr string
	}{
		{"valid", "annotations:\n  - checks: [actions-pinned-sha]\n    reasons:\n      - reason: test-data\n", ""},
		{"empty file", "", ""},
		{"unknown reason", "annotations:\n  - checks: [a]\n    reasons:\n      - reason: because\n", "reason is not valid: because"},
		{"missing reason", "annotations:\n  - checks: [a]\n", "no reason"},
		{"empty check", "annotations:\n  - checks: ['']\n    reasons:\n      - reason: remediated\n", "check is not valid"},
		{"bad yaml", "annotations: [", "parse annotations"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseAnnotations(strings.NewReader(tc.in))
			if tc.wantErr == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
				t.Fatalf("err = %v, want %q", err, tc.wantErr)
			}
		})
	}
}

func TestConfigReason(t *testing.T) {
	cfg, err := ParseAnnotations(strings.NewReader("annotations:\n  - checks: [Actions-Pinned-SHA]\n    reasons:\n      - reason: remediated\n"))
	if err != nil {
		t.Fatal(err)
	}
	if r, ok := cfg.Reason("actions-pinned-sha"); !ok || r != Remediated {
		t.Errorf("got %q %v", r, ok)
	}
	if _, ok := cfg.Reason("env-example"); ok {
		t.Error("unannotated id matched")
	}
	if _, ok := (Config{}).Reason("x"); ok {
		t.Error("empty config matched")
	}
}

func TestReasonDoc(t *testing.T) {
	for _, r := range []Reason{TestData, Remediated, NotApplicable, NotSupported, NotDetected} {
		if d := r.Doc(); d == "" || d == string(r) {
			t.Errorf("%s has no doc", r)
		}
	}
	if Reason("x").Doc() != "x" {
		t.Error("unknown reason should echo itself")
	}
}
