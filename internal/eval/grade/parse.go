// Ported from SWE-bench/SWE-bench@02e7a74 swebench/harness/log_parsers/python.py

package grade

import (
	"encoding/json"
	"regexp"
	"strings"
)

var skipSummaryCount = regexp.MustCompile(`^\[\d+\]$`)

// ParsePytest reads `pytest -rA` output: a line that starts with a status names the test in its second field.
// A SKIPPED "[N] path:line: reason" summary is not a test. The last line for a test wins.
func ParsePytest(out string) map[string]Status {
	m := map[string]Status{}
	for line := range strings.SplitSeq(out, "\n") {
		for _, s := range []Status{Failed, Passed, Skipped, Error, XFail} {
			if !strings.HasPrefix(line, string(s)) {
				continue
			}
			if s == Failed {
				line = strings.ReplaceAll(line, " - ", " ")
			}
			f := strings.Fields(line)
			if len(f) > 1 && (Status(f[0]) != Skipped || !skipSummaryCount.MatchString(f[1])) {
				m[f[1]] = Status(f[0])
			}
			break
		}
	}
	return m
}

// ParseGoTest reads `go test -json` output. A test is named "<package>.<Test>", subtests with "/".
// Package-level events and lines that are not JSON are ignored.
func ParseGoTest(out string) map[string]Status {
	m := map[string]Status{}
	for line := range strings.SplitSeq(out, "\n") {
		var ev struct{ Action, Package, Test string }
		if json.Unmarshal([]byte(line), &ev) != nil || ev.Test == "" {
			continue
		}
		switch ev.Action {
		case "pass":
			m[ev.Package+"."+ev.Test] = Passed
		case "fail":
			m[ev.Package+"."+ev.Test] = Failed
		case "skip":
			m[ev.Package+"."+ev.Test] = Skipped
		}
	}
	return m
}
