package gate

import (
	"context"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Fixture lines come from tests/scenarios.test.ts and src/gates.ts (parseGateLine).
func TestParse(t *testing.T) {
	tests := []struct {
		name   string
		out    string
		want   Result
		wantOK bool
	}{
		{"green", "FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-", Result{Status: "GREEN", Passed: 2, FailedGates: []string{}}, true},
		{"red with failed gates", "noise\nFACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit,lint\n", Result{Status: "RED", Passed: 1, Failed: 1, FailedGates: []string{"unit", "lint"}}, true},
		{"skipped", "FACTORY_GATES: status=GREEN passed=3 failed=0 skipped=2 failed_gates=", Result{Status: "GREEN", Passed: 3, Skipped: 2, FailedGates: []string{}}, true},
		{"lowercase status is upcased", "FACTORY_GATES: status=green passed=1 failed=0 skipped=0 failed_gates=-", Result{Status: "GREEN", Passed: 1, FailedGates: []string{}}, true},
		{"misconfigured is unknown", "FACTORY_GATES: status=MISCONFIGURED passed=0 failed=0 skipped=0 failed_gates=-", Result{Status: "UNKNOWN", FailedGates: []string{}}, true},
		{"first line wins", "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=a\nFACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-", Result{Status: "RED", Failed: 1, FailedGates: []string{"a"}}, true},
		{"malformed: missing field", "FACTORY_GATES: status=GREEN passed=2 failed=0", Result{}, false},
		{"malformed: bare marker", "FACTORY_GATES first", Result{}, false},
		{"malformed: non numeric", "FACTORY_GATES: status=GREEN passed=x failed=0 skipped=0 failed_gates=-", Result{}, false},
		{"missing", "all good\n", Result{}, false},
		{"empty", "", Result{}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Parse(tc.out)
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			got.Raw = ""
			if got.Status != tc.want.Status || got.Passed != tc.want.Passed || got.Failed != tc.want.Failed ||
				got.Skipped != tc.want.Skipped || strings.Join(got.FailedGates, ",") != strings.Join(tc.want.FailedGates, ",") {
				t.Fatalf("got %+v, want %+v", got, tc.want)
			}
		})
	}
}

func TestRunMissingLineIsFail(t *testing.T) {
	r := Run(context.Background(), Spec{Command: "echo hello", Timeout: 5 * time.Second})
	if r.Green() || r.Status != "UNKNOWN" || !strings.Contains(r.Reason, "no FACTORY_GATES line") {
		t.Fatalf("got %+v", r)
	}
	if !strings.Contains(r.Raw, "hello") {
		t.Fatalf("raw tail missing output: %q", r.Raw)
	}
}

func TestRunGreenAndRed(t *testing.T) {
	g := Run(context.Background(), Spec{Command: "echo 'FACTORY_GATES: status=GREEN passed=2 failed=0 skipped=0 failed_gates=-'", Timeout: 5 * time.Second})
	if !g.Green() {
		t.Fatalf("green: %+v", g)
	}
	r := Run(context.Background(), Spec{Command: "echo 'FACTORY_GATES: status=RED passed=1 failed=1 skipped=0 failed_gates=unit' >&2; exit 1", Timeout: 5 * time.Second})
	if r.Green() || r.Status != "RED" || r.FailedGates[0] != "unit" {
		t.Fatalf("red: %+v", r)
	}
}

func TestRunTailBound(t *testing.T) {
	r := Run(context.Background(), Spec{Command: "seq 1 100000; echo 'FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-'", Timeout: 10 * time.Second, TailBytes: 1024})
	if !r.Green() || len(r.Raw) > 1024 {
		t.Fatalf("green=%v raw=%d", r.Green(), len(r.Raw))
	}
}

// Symphony §8.5: a stalled run is stopped, and nothing it started survives.
func TestRunTimeoutKillsProcessGroup(t *testing.T) {
	pidFile := t.TempDir() + "/child.pid"
	start := time.Now()
	r := Run(context.Background(), Spec{
		Command: "sleep 60 & echo $! > " + pidFile + "; wait",
		Timeout: 300 * time.Millisecond,
	})
	if time.Since(start) > 10*time.Second {
		t.Fatalf("run took %v", time.Since(start))
	}
	if r.Green() || r.Status != "RED" || r.Reason != "timeout" || !r.TimedOut {
		t.Fatalf("got %+v", r)
	}
	b, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err != nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("child %d still alive", pid)
}
