// Ported from SWE-bench/SWE-bench@02e7a74 swebench/harness/grading.py

// Package grade scores a test run from its log against a fixture's expected test lists.
// It is pure: no files, no commands, no model.
package grade

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// suiteRan is evidence that a runner executed, to tell "ran, no failures" from "never ran" when the
// status map is empty. Every count must be non-zero: karma prints "Executed 0 of 0" when it
// loses its browser, and under FailOnly an empty map would score that as a pass.
var suiteRan = regexp.MustCompile(`(?m)` +
	`Executed [1-9]\d* of \d+` +
	`|TOTAL: [1-9]\d* (?:SUCCESS|FAILED)` +
	`|[1-9]\d* passing` +
	`|Tests:\s+[1-9]\d*` +
	`|Test Suites:\s+(?:\d+ \w+, )*[1-9]\d* total` +
	`|^# tests [1-9]\d*` +
	`|[1-9]\d* specs?, \d+ failures?` +
	`|': ok$`)

var exitCodeRe = regexp.MustCompile(regexp.QuoteMeta(ExitCode) + `:\s*(-?\d+)`)

// Spec is what a ticket expects: the tests that must go from failing to passing, those that must stay passing,
// and how to parse and read the log. The zero value is a pytest log read as PassAndFail.
type Spec struct {
	FailToPass []string `json:"fail_to_pass"`
	PassToPass []string `json:"pass_to_pass"`
	Parser     string   `json:"parser,omitempty"`
	EvalType   EvalType `json:"eval_type,omitempty"`
}

// Outcome lists the tests of one group that succeeded and failed.
type Outcome struct {
	Success []string `json:"success"`
	Failure []string `json:"failure"`
}

// Result is the grade of one log. Valid is false when the log does not describe a run that can be graded;
// Reason then says why, and Status is ResolvedNo.
type Result struct {
	Valid      bool           `json:"valid"`
	Reason     string         `json:"reason,omitempty"`
	Resolved   bool           `json:"resolved"`
	Status     ResolvedStatus `json:"status"`
	FailToPass Outcome        `json:"fail_to_pass"`
	PassToPass Outcome        `json:"pass_to_pass"`
}

// Grade scores log against fx.
func Grade(log string, fx Spec) Result {
	sm, reason := statusMap(log, fx)
	if reason != "" {
		return Result{Reason: reason, Status: ResolvedNo}
	}
	r := Result{Valid: true}
	r.FailToPass = group(fx.FailToPass, sm, fx.EvalType, testPassed)
	r.PassToPass = group(fx.PassToPass, sm, fx.EvalType, testMaintained)
	r.Status = resolution(r.FailToPass, r.PassToPass)
	r.Resolved = r.Status == ResolvedFull
	return r
}

// statusMap parses the log, or returns the reason it cannot be graded.
func statusMap(log string, fx Spec) (map[string]Status, string) {
	for _, m := range []string{ApplyFail, ResetFailed, TestsError, TestsTimeout} {
		if strings.Contains(log, m) {
			return nil, m
		}
	}
	_, after, ok := strings.Cut(log, StartOutput)
	body, _, ended := strings.Cut(after, EndOutput)
	if !ok || !ended {
		return nil, "log has no start and end test output markers"
	}
	parse := ParsePytest
	if fx.Parser == ParserGoTest {
		parse = ParseGoTest
	}
	sm := parse(body)
	if len(sm) == 0 { // some runners print outside the markers
		sm = parse(log)
	}
	if len(sm) == 0 && !suiteRan.MatchString(log) {
		return nil, "no test results and no sign the suite ran"
	}
	// A patch can print its own PASSED lines, so a non-zero exit with no failure at all means the log
	// does not describe the run. The code is read after the last end marker, outside the test output.
	tail := log[strings.LastIndex(log, EndOutput):]
	if m := exitCodeRe.FindStringSubmatch(tail); m != nil && len(sm) > 0 {
		if n, _ := strconv.Atoi(m[1]); n != 0 && !anyFailed(sm) {
			return nil, fmt.Sprintf("exit code %d but no test failed", n)
		}
	}
	return sm, ""
}

func anyFailed(sm map[string]Status) bool {
	for _, s := range sm {
		if s == Failed || s == Error {
			return true
		}
	}
	return false
}

func testPassed(c string, sm map[string]Status) bool {
	s, ok := sm[c]
	return ok && (s == Passed || s == XFail)
}

// testMaintained is the pass-to-pass reading: a skipped test is not a regression.
func testMaintained(c string, sm map[string]Status) bool {
	return testPassed(c, sm) || sm[c] == Skipped
}

// testFailed is true for a missing test, and for a skipped one: a skipped fail-to-pass test is not a resolution.
func testFailed(c string, sm map[string]Status) bool {
	s, ok := sm[c]
	return !ok || s == Failed || s == Error || s == Skipped
}

func group(tests []string, sm map[string]Status, et EvalType, ok func(string, map[string]Status) bool) Outcome {
	o := Outcome{Success: []string{}, Failure: []string{}}
	for _, c := range tests {
		switch {
		case et == FailOnly:
			if sm[c] == Failed {
				o.Failure = append(o.Failure, c)
			} else {
				o.Success = append(o.Success, c)
			}
		case ok(c, sm):
			o.Success = append(o.Success, c)
		case testFailed(c, sm):
			o.Failure = append(o.Failure, c)
		}
	}
	return o
}

func ratio(o Outcome) float64 {
	if n := len(o.Success) + len(o.Failure); n > 0 {
		return float64(len(o.Success)) / float64(n)
	}
	return 1
}

func resolution(f2p, p2p Outcome) ResolvedStatus {
	a, b := ratio(f2p), ratio(p2p)
	switch {
	case a == 1 && b == 1:
		return ResolvedFull
	case a > 0 && a < 1 && b == 1:
		return ResolvedPartial
	}
	return ResolvedNo
}

// Script wraps a test command in the runner script the grader reads: start marker, the command in a
// subshell so its own exit cannot end the script, end marker, then the command's exit status.
func Script(command string) string {
	return "echo '" + StartOutput + "'\n(\n" + command + "\n)\nFACTORY_TEST_EXIT_CODE=$?\n" +
		"echo '" + EndOutput + "'\necho \"" + ExitCode + ": $FACTORY_TEST_EXIT_CODE\"\n"
}
