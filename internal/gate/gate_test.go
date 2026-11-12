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

const greenLine = "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-"

// Tail is set for every outcome: green, red, missing line and timeout.
func TestRunTailAlwaysSet(t *testing.T) {
	tests := []struct {
		name    string
		command string
		timeout time.Duration
		want    string
	}{
		{"pass", "echo build ok; echo '" + greenLine + "'", 5 * time.Second, "build ok"},
		{"fail", "echo 'FAIL: TestX' >&2; echo 'FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=unit'; exit 1", 5 * time.Second, "FAIL: TestX"},
		{"missing line", "echo only noise", 5 * time.Second, "only noise"},
		{"timeout", "echo before the hang; sleep 60", 500 * time.Millisecond, "before the hang"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			r := Run(context.Background(), Spec{Command: tc.command, Timeout: tc.timeout})
			if !strings.Contains(r.Tail, tc.want) {
				t.Fatalf("Tail = %q, want it to contain %q", r.Tail, tc.want)
			}
		})
	}
}

func TestRunTailKeepsLast60LinesUnder8KB(t *testing.T) {
	r := Run(context.Background(), Spec{Command: "seq 1 10000", Timeout: 10 * time.Second})
	lines := strings.Split(r.Tail, "\n")
	if len(lines) != 60 || lines[0] != "9941" || lines[59] != "10000" {
		t.Fatalf("got %d lines, first %q last %q", len(lines), lines[0], lines[len(lines)-1])
	}
	if len(r.Tail) >= 8*1024 {
		t.Fatalf("tail is %d bytes", len(r.Tail))
	}
}

func TestRunTailByteCap(t *testing.T) {
	r := Run(context.Background(), Spec{Command: "i=0; while [ $i -lt 60 ]; do printf '%0300d\\n' $i; i=$((i+1)); done", Timeout: 10 * time.Second})
	if len(r.Tail) > 8*1024 || !strings.HasSuffix(r.Tail, "000000000059") {
		t.Fatalf("tail is %d bytes, ends %q", len(r.Tail), r.Tail[max(0, len(r.Tail)-12):])
	}
	for _, l := range strings.Split(r.Tail, "\n") {
		if len(l) != 300 {
			t.Fatalf("tail has a cut line of %d bytes", len(l))
		}
	}
}

// Fake tokens are built from parts so no scanner mistakes this file for a leak.
func TestRunTailRedactsTokens(t *testing.T) {
	tokens := map[string]string{
		"ghp":        "ghp_" + strings.Repeat("a1", 12),
		"github_pat": "github_pat_" + strings.Repeat("B2", 15),
		"sk":         "sk-" + strings.Repeat("c3", 12),
		"xoxb":       "xoxb-" + "123456789012-abcdefghij",
		"xoxp":       "xoxp-" + "123456789012-abcdefghij",
		"akia":       "AKIA" + "ABCDEFGHIJKLMNOP",
	}
	for name, tok := range tokens {
		t.Run(name, func(t *testing.T) {
			r := Run(context.Background(), Spec{Command: "echo keep me; echo 'using " + tok + " now'; echo after", Timeout: 5 * time.Second})
			if strings.Contains(r.Tail, tok) || strings.Contains(r.Tail, "using") {
				t.Fatalf("token leaked: %q", r.Tail)
			}
			if r.Tail != "keep me\n[redacted]\nafter" {
				t.Fatalf("Tail = %q", r.Tail)
			}
		})
	}
	t.Run("ordinary text stays", func(t *testing.T) {
		r := Run(context.Background(), Spec{Command: "echo task-list ask-me ghp_ AKIAshort", Timeout: 5 * time.Second})
		if r.Tail != "task-list ask-me ghp_ AKIAshort" {
			t.Fatalf("Tail = %q", r.Tail)
		}
	})
}
