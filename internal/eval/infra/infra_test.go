package infra

import "testing"

// TestClassifyTable has a row for every signature, the tier split, order and the no-match branch.
func TestClassifyTable(t *testing.T) {
	tests := []struct {
		name, log, reason string
		tier              Tier
		ok                bool
	}{
		{"browser", "Error: Failed to launch the browser", "browser_launch_failed", TierEnvironment, true},
		{"display", "cannot open display :0", "display_unavailable", TierEnvironment, true},
		{"oom text", "fatal: Cannot allocate memory", "out_of_memory", TierEnvironment, true},
		{"oom bare Killed line", "running\nKilled\n", "out_of_memory", TierEnvironment, true},
		{"Killed inside a sentence is not OOM", "the Killed flag was set", "", "", false},
		{"docker", "Cannot connect to the Docker daemon at unix:///x", "container_unavailable", TierEnvironment, true},
		{"dns", "curl: Could not resolve host: x", "network_unreachable", TierEnvironment, true},
		{"sandbox kill", "sandbox: process killed by signal 9", "sandbox_killed", TierEnvironment, true},
		{"sandbox oom", "sandbox: out of memory", "sandbox_oom", TierEnvironment, true},
		{"rate limit 429", "HTTP 429 Too Many Requests", "rate_limited", TierEnvironment, true},
		{"rate limit text", "rate limit exceeded, retry later", "rate_limited", TierEnvironment, true},
		{"test name mentioning rate limit is not rate_limited", "--- FAIL: TestRateLimitBackoff (0.00s)\n    x_test.go:9: too many requests handled, rate limit ok", "", "", false},
		{"prose mentioning Failed to launch is not a browser failure", "    x_test.go:3: Failed to launch worker", "", "", false},
		{"api error 429", "API Error: 429 Too Many Requests", "rate_limited", TierEnvironment, true},
		{"missing module", "ModuleNotFoundError: No module named x", "missing_module", TierAmbiguous, true},
		{"no tests", "collected 0 items", "no_tests_collected", TierAmbiguous, true},
		{"timeout", "Timeout error: 1800 seconds exceeded", "tests_timed_out", TierAmbiguous, true},
		{"order: environment before ambiguous", "ModuleNotFoundError\nCannot allocate memory", "out_of_memory", TierEnvironment, true},
		{"plain test failure", "--- FAIL: TestX\nFAIL", "", "", false},
		{"empty", "", "", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := Classify(tc.log)
			if ok != tc.ok || got.Reason != tc.reason || got.Tier != tc.tier {
				t.Fatalf("got %+v %v, want %s %s %v", got, ok, tc.reason, tc.tier, tc.ok)
			}
		})
	}
}

// TestSummaryKeepsFailuresSeparate: environment and ambiguous wording differs from a test failure.
func TestSummary(t *testing.T) {
	tests := []struct {
		name string
		c    Class
		ok   bool
		want string
	}{
		{"none", Class{}, false, ""},
		{"environment", Class{"out_of_memory", TierEnvironment}, true, "environment failure (out_of_memory); this is not a test failure."},
		{"ambiguous", Class{"missing_module", TierAmbiguous}, true, "possible environment failure (missing_module); tests may also have failed."},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := Summary(tc.c, tc.ok); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestHasTestFailure(t *testing.T) {
	for log, want := range map[string]bool{"--- FAIL: TestX": true, "ok\nFAIL\tpkg\t1s": true, "ok pkg": false, "a --- FAIL: x": false, "": false} {
		if HasTestFailure(log) != want {
			t.Errorf("%q: want %v", log, want)
		}
	}
}
