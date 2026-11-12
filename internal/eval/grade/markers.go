// Ported from SWE-bench/SWE-bench@02e7a74 swebench/harness/constants/__init__.py

package grade

// Log markers. The `>>>>> ` convention and the strings are upstream's, so a log from either runner reads the same.
const (
	ApplyFail    = ">>>>> Patch Apply Failed"
	ResetFailed  = ">>>>> Reset Failed"
	TestsError   = ">>>>> Tests Errored"
	TestsTimeout = ">>>>> Tests Timed Out"
	StartOutput  = ">>>>> Start Test Output"
	EndOutput    = ">>>>> End Test Output"
	// ExitCode is followed by ": <n>", the test command's own exit status, written after EndOutput.
	ExitCode = ">>>>> Test Exit Code"
)

// Status is one test's outcome in a status map.
type Status string

// The statuses a parser may record.
const (
	Failed  Status = "FAILED"
	Passed  Status = "PASSED"
	Skipped Status = "SKIPPED"
	Error   Status = "ERROR"
	XFail   Status = "XFAIL"
)

// ResolvedStatus is the verdict on one run: all, some or none of the fail-to-pass tests resolved.
type ResolvedStatus string

// The three verdicts.
const (
	ResolvedFull    ResolvedStatus = "RESOLVED_FULL"
	ResolvedPartial ResolvedStatus = "RESOLVED_PARTIAL"
	ResolvedNo      ResolvedStatus = "RESOLVED_NO"
)

// EvalType picks how a missing test is read.
type EvalType string

// PassAndFail counts a missing test as a failure; FailOnly counts only an explicit FAILED.
const (
	PassAndFail EvalType = "pass_and_fail"
	FailOnly    EvalType = "fail_only"
)

// Parser names a log parser.
const (
	ParserPytest = "pytest"
	ParserGoTest = "gotest"
)
