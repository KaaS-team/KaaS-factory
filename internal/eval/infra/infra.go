// Ported from SWE-bench/SWE-bench@02e7a74 swebench/harness/infra_failure.py

// Package infra tells an environment failure from a failed change by signatures in a run log.
// It is advisory: it reads text and never decides whether a run counts, so no run leaves the denominator.
package infra

import "regexp"

// Tier says how sure a signature is that the environment, not the change, broke.
type Tier string

const (
	// TierEnvironment cannot plausibly come from patching repository source.
	TierEnvironment Tier = "environment"
	// TierAmbiguous can come from a broken environment or a bad change.
	TierAmbiguous Tier = "ambiguous"
)

// Class is the first matching signature of a log.
type Class struct {
	Reason string
	Tier   Tier
}

type signature struct {
	reason string
	tier   Tier
	re     *regexp.Regexp
}

// Signatures that name a condition a test can print (rate limit, launch failure) are anchored to the start
// of a line in the runner's own wording, so a test name or message that mentions them stays a test failure.
// signatures are tried in order; the first hit wins. sandbox_oom, sandbox_killed and rate_limited are ours;
// the rest are upstream's table.
var signatures = []signature{
	{"browser_launch_failed", TierEnvironment, regexp.MustCompile(`(?m)^(?:Error: |browserType\.launch: )?Failed to launch (?:the )?(?:browser|chrom)|^Failed to connect to the bus`)},
	{"display_unavailable", TierEnvironment, regexp.MustCompile(`cannot open display|Missing X server|unable to open X display`)},
	{"sandbox_oom", TierEnvironment, regexp.MustCompile(`sandbox: out of memory`)},
	{"sandbox_killed", TierEnvironment, regexp.MustCompile(`sandbox: process killed`)},
	{"out_of_memory", TierEnvironment, regexp.MustCompile(`(?m)Cannot allocate memory|OutOfMemoryError|^Killed$`)},
	{"container_unavailable", TierEnvironment, regexp.MustCompile(`Error response from daemon|Cannot connect to the Docker daemon`)},
	{"network_unreachable", TierEnvironment, regexp.MustCompile(`Could not resolve host|Temporary failure in name resolution`)},
	{"rate_limited", TierEnvironment, regexp.MustCompile(`(?mi)^(?:api error: |error: )?(?:http )?429 too many requests|^(?:api error: |error: )?rate limit (?:exceeded|reached)`)},
	{"missing_module", TierAmbiguous, regexp.MustCompile(`Cannot find module|MODULE_NOT_FOUND|ModuleNotFoundError`)},
	{"no_tests_collected", TierAmbiguous, regexp.MustCompile(`no tests ran|collected 0 items`)},
	{"tests_timed_out", TierAmbiguous, regexp.MustCompile(`Timeout error: \d+ seconds exceeded`)},
}

// Classify returns the first matching signature of the log, or false when none matches.
func Classify(log string) (Class, bool) {
	for _, s := range signatures {
		if s.re.MatchString(log) {
			return Class{s.reason, s.tier}, true
		}
	}
	return Class{}, false
}

// Summary is one sentence for a report, empty when nothing matched. An environment failure is
// worded apart from a test failure.
func Summary(c Class, ok bool) string {
	switch {
	case !ok:
		return ""
	case c.Tier == TierEnvironment:
		return "environment failure (" + c.Reason + "); this is not a test failure."
	default:
		return "possible environment failure (" + c.Reason + "); tests may also have failed."
	}
}

var testFailure = regexp.MustCompile(`(?m)^(?:--- FAIL: |FAIL\t|FAIL$|not ok |FAILED )`)

// HasTestFailure reports whether the log has a test runner's own failure line (go test, TAP, pytest), which
// outranks any environment signature: a gate that failed a test is red, not unknown.
func HasTestFailure(log string) bool { return testFailure.MatchString(log) }
