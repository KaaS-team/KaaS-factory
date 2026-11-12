// Ported from promptfoo/promptfoo@4f6710156d4a8426b852cf3af2b54c593a0e5177 src/assertions/trajectory.ts
// Also ported from src/assertions/traceUtils.ts (matchesPattern). MIT, see THIRD_PARTY_NOTICES.md.
// Only tool steps exist in our log, and the goal-success handler (model judged) is not ported.

package assert

import (
	"fmt"
	"regexp"
	"strings"
)

// matchesPattern is a case-blind glob: * is any run, ? is one character.
func matchesPattern(name, pattern string) bool {
	q := regexp.QuoteMeta(pattern)
	q = strings.ReplaceAll(strings.ReplaceAll(q, `\*`, ".*"), `\?`, ".")
	return regexp.MustCompile("(?is)^" + q + "$").MatchString(name)
}

// expected lists the tool patterns an assertion names: Values, else Value.
func (a Assertion) expected() []string {
	if len(a.Values) > 0 {
		return a.Values
	}
	if a.Value != "" {
		return []string{a.Value}
	}
	return nil
}

func labels(tools []ToolCall) string {
	if len(tools) == 0 {
		return "(none)"
	}
	s := make([]string, len(tools))
	for i, t := range tools {
		s[i] = "tool:" + t.Name
	}
	return strings.Join(s, ", ")
}

func matching(tools []ToolCall, pattern string) []ToolCall {
	var out []ToolCall
	for _, t := range tools {
		if matchesPattern(t.Name, pattern) {
			out = append(out, t)
		}
	}
	return out
}

func inRange(count int, min, max *int) bool {
	return (min == nil || count >= *min) && (max == nil || count <= *max)
}

func flip(pass, inverse bool) bool { return pass != inverse }

func result(pass bool, reason string) Result {
	r := Result{Pass: pass, Reason: reason}
	if pass {
		r.Score = 1
	}
	return r
}

func runToolUsed(a Assertion, inverse bool, tools []ToolCall) (Result, error) {
	want := a.expected()
	if len(want) == 0 {
		return Result{}, fmt.Errorf("requires at least one expected tool")
	}
	if a.Min != nil || a.Max != nil {
		min := 1
		if a.Min != nil {
			min = *a.Min
		}
		hits := matching(tools, want[0])
		basePass := inRange(len(hits), &min, a.Max)
		if inverse {
			if basePass {
				return result(false, fmt.Sprintf("Tool %q matched %d time(s), which violates the inverse assertion", want[0], len(hits))), nil
			}
			return result(true, fmt.Sprintf("Tool %q did not satisfy the forbidden match condition", want[0])), nil
		}
		reason := fmt.Sprintf("Matched tool %q %d time(s) (expected at least %d)", want[0], len(hits), min)
		if a.Max != nil {
			reason = fmt.Sprintf("Matched tool %q %d time(s) (expected %d-%d)", want[0], len(hits), min, *a.Max)
		}
		if len(hits) > 0 {
			reason += ". Matches: " + labels(hits)
		}
		return result(basePass, reason), nil
	}
	var missing, matched []string
	for _, w := range want {
		if len(matching(tools, w)) == 0 {
			missing = append(missing, w)
		} else {
			matched = append(matched, w)
		}
	}
	switch {
	case inverse && len(matched) == 0:
		return result(true, "Forbidden tool(s) were not used: "+strings.Join(want, ", ")), nil
	case inverse:
		return result(false, fmt.Sprintf("Forbidden tool(s) were used: %s. Actual tools: %s", strings.Join(matched, ", "), labels(tools))), nil
	case len(missing) == 0:
		return result(true, fmt.Sprintf("Observed required tool(s): %s. Actual tools: %s", strings.Join(want, ", "), labels(tools))), nil
	}
	return result(false, fmt.Sprintf("Missing required tool(s): %s. Actual tools: %s", strings.Join(missing, ", "), labels(tools))), nil
}

func runToolSequence(a Assertion, inverse bool, tools []ToolCall) (Result, error) {
	want := a.expected()
	if len(want) == 0 {
		return Result{}, fmt.Errorf("requires at least one expected step")
	}
	var basePass bool
	var reason string
	if a.Mode == "exact" {
		basePass = len(tools) == len(want)
		for i := 0; basePass && i < len(want); i++ {
			basePass = matchesPattern(tools[i].Name, want[i])
		}
		if basePass {
			reason = "Observed exact tool sequence: " + labels(tools)
		} else {
			reason = fmt.Sprintf("Expected exact tool sequence of %s, but actual tools were %s", strings.Join(want, ", "), labels(tools))
		}
	} else {
		next := 0
		var seen []ToolCall
		for _, t := range tools {
			if next < len(want) && matchesPattern(t.Name, want[next]) {
				seen = append(seen, t)
				next++
			}
		}
		basePass = next == len(want)
		if basePass {
			reason = fmt.Sprintf("Observed tool sequence in order: %s. Actual tools: %s", labels(seen), labels(tools))
		} else {
			reason = fmt.Sprintf("Expected tool %q was not observed in order. Actual tools: %s", want[next], labels(tools))
		}
	}
	if inverse {
		reason = "Forbidden tool sequence was not observed"
		if basePass {
			reason = "Forbidden tool sequence was observed. Actual tools: " + labels(tools)
		}
	}
	return result(flip(basePass, inverse), reason), nil
}

func runStepCount(a Assertion, inverse bool, tools []ToolCall) (Result, error) {
	if a.Min == nil && a.Max == nil {
		return Result{}, fmt.Errorf("must include a min or max property")
	}
	steps, filter := tools, ""
	if a.Value != "" {
		steps, filter = matching(tools, a.Value), " for pattern="+a.Value
	}
	basePass := inRange(len(steps), a.Min, a.Max)
	reason := fmt.Sprintf("Matched %d trajectory step(s)%s", len(steps), filter)
	switch {
	case a.Min != nil && a.Max != nil:
		reason += fmt.Sprintf(" (expected %d-%d)", *a.Min, *a.Max)
	case a.Min != nil:
		reason += fmt.Sprintf(" (expected at least %d)", *a.Min)
	default:
		reason += fmt.Sprintf(" (expected at most %d)", *a.Max)
	}
	if len(steps) > 0 {
		reason += ". Matches: " + labels(steps)
	}
	if inverse {
		reason = "Trajectory step count did not satisfy the forbidden range"
		if basePass {
			reason = "Trajectory step count satisfied the forbidden range"
		}
	}
	return result(flip(basePass, inverse), reason), nil
}
