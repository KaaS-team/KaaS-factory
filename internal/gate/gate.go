// Package gate runs a repo's gate command and reads its FACTORY_GATES line.
package gate

import (
	"context"
	"errors"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultTail is how many bytes of output Run keeps when Spec.TailBytes is zero.
const DefaultTail = 2000

// Tail limits: the lines and bytes of output kept in Result.Tail, and the buffer Run reads them from.
const (
	tailLines  = 60
	tailCap    = 8 * 1024
	bufferSize = 64 * 1024
)

// secretRE matches the shapes of common tokens: GitHub, OpenAI-style, Slack and AWS keys.
var secretRE = regexp.MustCompile(`ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\bsk-[A-Za-z0-9_-]{16,}|xox[bp]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}`)

// WaitDelay bounds how long Run waits for output pipes after the process group is killed.
const waitDelay = 2 * time.Second

// Result is the graded outcome of one gate run.
type Result struct {
	Status      string   // GREEN, RED or UNKNOWN
	Passed      int      // gates that passed
	Failed      int      // gates that failed
	Skipped     int      // gates that were skipped
	FailedGates []string // names of failed gates, or the reason when there was no line
	Raw         string   // the matched line, or the output tail when there was none
	Reason      string   // why the run is not green when no line says so: "timeout" or a missing line
	TimedOut    bool     // true when the deadline killed the run
	Tail        string   // last 60 lines (at most 8 KB) of stdout and stderr, secrets redacted; set for every outcome
}

// Green reports whether the gate run passed. Only a GREEN line counts.
func (r Result) Green() bool { return r.Status == "GREEN" && !r.TimedOut }

// Spec describes one gate run.
type Spec struct {
	Command   string        // run with `sh -c`
	Dir       string        // working directory, empty for the current one
	Env       []string      // extra KEY=VALUE entries added to the environment
	Timeout   time.Duration // zero means no deadline beyond ctx
	TailBytes int           // output bytes kept, DefaultTail when zero
}

var lineRE = regexp.MustCompile(`FACTORY_GATES:\s*status=(\w+)\s+passed=(\d+)\s+failed=(\d+)\s+skipped=(\d+)\s+failed_gates=(\S*)`)

// Parse reads the first FACTORY_GATES line in output, as parseGateLine in src/gates.ts does.
// The second result is false when there is no well-formed line.
func Parse(output string) (Result, bool) {
	m := lineRE.FindStringSubmatch(output)
	if m == nil {
		return Result{}, false
	}
	nums := [3]int{}
	for i := range nums {
		n, err := strconv.Atoi(m[2+i])
		if err != nil {
			return Result{}, false
		}
		nums[i] = n
	}
	status := strings.ToUpper(m[1])
	if status == "MISCONFIGURED" {
		status = "UNKNOWN" // a gate that could not run says nothing about the build
	}
	gates := []string{}
	if m[5] != "" && m[5] != "-" {
		for _, g := range strings.Split(m[5], ",") {
			if g != "" {
				gates = append(gates, g)
			}
		}
	}
	return Result{Status: status, Passed: nums[0], Failed: nums[1], Skipped: nums[2], FailedGates: gates, Raw: m[0]}, true
}

// Run executes the gate command in its own process group and grades its output.
// On timeout or cancellation it kills the whole group and reports a RED result with reason "timeout".
func Run(ctx context.Context, s Spec) Result {
	tail := s.TailBytes
	if tail <= 0 {
		tail = DefaultTail
	}
	runCtx := ctx
	if s.Timeout > 0 {
		var cancel context.CancelFunc
		runCtx, cancel = context.WithTimeout(ctx, s.Timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(runCtx, "sh", "-c", s.Command)
	cmd.Dir = s.Dir
	if len(s.Env) > 0 {
		cmd.Env = append(cmd.Environ(), s.Env...)
	}
	setGroup(cmd)
	buf := &tailBuffer{max: max(tail, bufferSize)}
	cmd.Stdout, cmd.Stderr = buf, buf
	cmd.WaitDelay = waitDelay

	err := cmd.Start()
	if err == nil {
		err = cmd.Wait()
	}
	full := buf.String()
	out := full[max(0, len(full)-tail):]
	tl := makeTail(full)
	if runCtx.Err() != nil {
		return Result{Status: "RED", Failed: 1, FailedGates: []string{}, Raw: out, Reason: "timeout", TimedOut: true, Tail: tl}
	}
	if r, ok := Parse(full); ok {
		r.Tail = tl
		return r
	}
	reason := "gates produced no FACTORY_GATES line"
	var ee *exec.ExitError
	if err != nil && !errors.As(err, &ee) {
		reason += ": " + err.Error()
	}
	return Result{Status: "UNKNOWN", FailedGates: []string{reason}, Raw: out, Reason: reason, Tail: tl}
}

// makeTail keeps the last tailLines lines of out, replaces lines that look like tokens with
// [redacted], and trims the front to whole lines so the result is at most tailCap bytes.
func makeTail(out string) string {
	lines := strings.Split(strings.TrimRight(out, "\n"), "\n")
	if len(lines) > tailLines {
		lines = lines[len(lines)-tailLines:]
	}
	for i, l := range lines {
		if secretRE.MatchString(l) {
			lines[i] = "[redacted]"
		}
	}
	s := strings.Join(lines, "\n")
	if len(s) > tailCap {
		s = s[len(s)-tailCap:]
		if i := strings.IndexByte(s, '\n'); i >= 0 {
			s = s[i+1:]
		}
	}
	return s
}

// tailBuffer keeps the last max bytes written to it. It is safe for the two writers exec starts.
type tailBuffer struct {
	mu  sync.Mutex
	max int
	b   []byte
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.b = append(t.b, p...)
	if len(t.b) > t.max {
		t.b = append([]byte(nil), t.b[len(t.b)-t.max:]...)
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.b)
}
