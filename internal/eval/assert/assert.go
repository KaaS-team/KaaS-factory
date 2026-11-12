// Ported from promptfoo/promptfoo@4f6710156d4a8426b852cf3af2b54c593a0e5177 src/assertions/contains.ts
// Also ported from src/assertions/{regex,json,cost,latency}.ts at the same SHA. MIT, see THIRD_PARTY_NOTICES.md.

// Package assert is a deterministic assertion kit with promptfoo's names and
// scoring. It never calls a model: every assertion reads the output, the cost,
// the latency or the tool-call log it is given.
package assert

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"strings"
)

// ToolCall is one entry of the session's tool-call event log, in call order.
type ToolCall struct {
	Name string `json:"name"`
}

// Output is what the assertions look at for one run.
type Output struct {
	Text            string     // the final text; wins over Structured when not empty
	Structured      any        // tool-call or JSON-mode output, serialised before matching
	ProviderRefusal bool       // the provider said it refused
	Transformed     bool       // output went through a transform, so ProviderRefusal is ignored
	CostUSD         *float64   // nil when the run reported no cost
	LatencyMs       *float64   // nil when no latency was measured
	Tools           []ToolCall // the tool-call log
}

// Assertion is one check. Type is a promptfoo name, optionally prefixed "not-".
type Assertion struct {
	Type      string      `json:"type"`
	Value     string      `json:"value,omitempty"`
	Values    []string    `json:"values,omitempty"`
	Threshold *float64    `json:"threshold,omitempty"`
	Weight    *float64    `json:"weight,omitempty"` // nil means 1; 0 measures without failing
	Metric    string      `json:"metric,omitempty"`
	Min       *int        `json:"min,omitempty"`
	Max       *int        `json:"max,omitempty"`
	Mode      string      `json:"mode,omitempty"`   // tool-sequence: "in_order" (default) or "exact"
	Assert    []Assertion `json:"assert,omitempty"` // members of an assert-set
}

// Result is the graded outcome of one assertion, one set or a whole test.
type Result struct {
	Type              string
	Pass              bool
	Score             float64
	Reason            string
	NamedScores       map[string]float64
	NamedScoreWeights map[string]float64
	Components        []Result
}

// text is the output as the string assertions match against.
func (o Output) text() string {
	if o.Text != "" || o.Structured == nil {
		return o.Text
	}
	b, err := json.Marshal(o.Structured)
	if err != nil {
		return fmt.Sprint(o.Structured)
	}
	return string(b)
}

// aliases map the kit's short names onto promptfoo's.
var aliases = map[string]string{
	"json-valid":    "is-json",
	"tool-used":     "trajectory:tool-used",
	"tool-sequence": "trajectory:tool-sequence",
	"step-count":    "trajectory:step-count",
}

// RunOne grades one assertion (not a set) against the output. A zero weight
// reads as pass, so a measure-only assertion never fails a test.
func RunOne(a Assertion, o Output) (Result, error) {
	typ, inverse := strings.TrimPrefix(a.Type, "not-"), strings.HasPrefix(a.Type, "not-")
	if alias, ok := aliases[typ]; ok {
		typ = alias
	}
	var r Result
	var err error
	switch typ {
	case "contains", "icontains", "contains-any", "icontains-any", "contains-all", "icontains-all":
		r, err = runContains(a, typ, inverse, o.text())
	case "regex":
		r, err = runRegex(a, inverse, o.text())
	case "is-json":
		r = runIsJSON(inverse, o.text())
	case "is-refusal":
		r = runRefusal(o, inverse)
	case "cost":
		r, err = runCost(a, inverse, o.CostUSD)
	case "latency":
		r, err = runLatency(a, inverse, o.LatencyMs)
	case "trajectory:tool-used":
		r, err = runToolUsed(a, inverse, o.Tools)
	case "trajectory:tool-sequence":
		r, err = runToolSequence(a, inverse, o.Tools)
	case "trajectory:step-count":
		r, err = runStepCount(a, inverse, o.Tools)
	case "assert-set":
		err = fmt.Errorf("assert-set is a group; run it through Evaluate")
	default:
		err = fmt.Errorf("unknown assertion type %q", a.Type)
	}
	if err != nil {
		return Result{}, fmt.Errorf("%s: %w", a.Type, err)
	}
	r.Type = a.Type
	if a.Weight != nil && *a.Weight == 0 {
		r.Pass = true
	}
	return r, nil
}

// verdict builds the common pass/fail result with the score promptfoo gives it.
func verdict(pass bool, failReason string) Result {
	if pass {
		return Result{Pass: true, Score: 1, Reason: "Assertion passed"}
	}
	return Result{Reason: failReason}
}

func not(inverse bool) string {
	if inverse {
		return "not "
	}
	return ""
}

func runContains(a Assertion, typ string, inverse bool, out string) (Result, error) {
	fold := strings.HasPrefix(typ, "i")
	mode := strings.TrimPrefix(strings.TrimPrefix(typ, "i"), "contains")
	includes := func(item string) bool {
		if fold {
			return strings.Contains(strings.ToLower(out), strings.ToLower(item))
		}
		return strings.Contains(out, item)
	}
	if mode == "" {
		if a.Value == "" {
			return Result{}, fmt.Errorf("must have a string value")
		}
		return verdict(includes(a.Value) != inverse, fmt.Sprintf("Expected output to %scontain \"%s\"", not(inverse), a.Value)), nil
	}
	values := a.Values
	if len(values) == 0 && a.Value != "" {
		for _, v := range strings.Split(a.Value, ",") {
			values = append(values, strings.TrimSpace(v))
		}
	}
	if len(values) == 0 {
		return Result{}, fmt.Errorf("must have a value")
	}
	if mode == "-any" {
		matches := false
		for _, v := range values {
			matches = matches || includes(v)
		}
		return verdict(matches != inverse, fmt.Sprintf("Expected output to %scontain one of \"%s\"", not(inverse), strings.Join(values, ", "))), nil
	}
	var missing []string
	for _, v := range values {
		if !includes(v) {
			missing = append(missing, v)
		}
	}
	return verdict((len(missing) == 0) != inverse, fmt.Sprintf("Expected output to %scontain all of [%s]. Missing: [%s]", not(inverse), strings.Join(values, ", "), strings.Join(missing, ", "))), nil
}

// runRegex uses Go's RE2 syntax, which has no lookaround or backreferences.
func runRegex(a Assertion, inverse bool, out string) (Result, error) {
	if a.Value == "" {
		return Result{}, fmt.Errorf("must have a string value")
	}
	re, err := regexp.Compile(a.Value)
	if err != nil {
		return Result{Reason: "Invalid regex pattern: " + err.Error()}, nil
	}
	return verdict(re.MatchString(out) != inverse, fmt.Sprintf("Expected output to %smatch regex \"%s\"", not(inverse), a.Value)), nil
}

// runIsJSON checks the syntax only; schema validation is not ported.
func runIsJSON(inverse bool, out string) Result {
	return verdict(json.Valid([]byte(out)) != inverse, fmt.Sprintf("Expected output to %sbe valid JSON", not(inverse)))
}

func runRefusal(o Output, inverse bool) Result {
	if !o.Transformed && o.ProviderRefusal {
		if inverse {
			return Result{Reason: "Expected output to not be a refusal"}
		}
		return Result{Pass: true, Score: 1, Reason: "Provider reported a refusal"}
	}
	text := o.text()
	if strings.TrimSpace(text) == "" {
		if inverse {
			return Result{Reason: "Expected output to not be a refusal"}
		}
		return Result{Pass: true, Reason: "Empty response treated as refusal"}
	}
	return verdict(IsBasicRefusal(text) != inverse, fmt.Sprintf("Expected output to %sbe a refusal", not(inverse)))
}

func runCost(a Assertion, inverse bool, cost *float64) (Result, error) {
	if a.Threshold == nil {
		if a.Metric != "" && a.Weight != nil && *a.Weight == 0 && !inverse {
			if cost == nil || math.IsNaN(*cost) || math.IsInf(*cost, 0) || *cost < 0 {
				return Result{}, fmt.Errorf("cost metric requires a finite, non-negative provider cost")
			}
			return Result{Pass: true, Score: *cost, Reason: fmt.Sprintf("Cost: $%v", *cost)}, nil
		}
		return Result{}, fmt.Errorf("must have a threshold")
	}
	if cost == nil {
		return Result{}, fmt.Errorf("does not support providers that do not return cost")
	}
	cmp := "greater than"
	if inverse {
		cmp = "less than or equal to"
	}
	return verdict((*cost <= *a.Threshold) != inverse, fmt.Sprintf("Cost %.2g is %s threshold %v", *cost, cmp, *a.Threshold)), nil
}

func runLatency(a Assertion, inverse bool, ms *float64) (Result, error) {
	if a.Threshold == nil {
		return Result{}, fmt.Errorf("must have a threshold in milliseconds")
	}
	if ms == nil {
		return Result{}, fmt.Errorf("needs a measured latency")
	}
	cmp := "greater than"
	if inverse {
		cmp = "less than or equal to"
	}
	return verdict((*ms <= *a.Threshold) != inverse, fmt.Sprintf("Latency %vms is %s threshold %vms", *ms, cmp, *a.Threshold)), nil
}
