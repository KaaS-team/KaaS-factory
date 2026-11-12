package assert

import (
	"math"
	"strings"
	"testing"
)

func f(v float64) *float64 { return &v }
func n(v int) *int         { return &v }

func tools(names ...string) []ToolCall {
	var out []ToolCall
	for _, s := range names {
		out = append(out, ToolCall{Name: s})
	}
	return out
}

// TestAssertionsOneFailingAndOnePassingCase has a failing row for every assertion
// type and its inverse, plus the pass row.
func TestAssertionsOneFailingAndOnePassingCase(t *testing.T) {
	tests := []struct {
		name string
		a    Assertion
		out  Output
		pass bool
		why  string // substring of the reason
	}{
		{"contains pass", Assertion{Type: "contains", Value: "ok"}, Output{Text: "all ok"}, true, "Assertion passed"},
		{"contains fail", Assertion{Type: "contains", Value: "ok"}, Output{Text: "nope"}, false, `contain "ok"`},
		{"not-contains fail", Assertion{Type: "not-contains", Value: "ok"}, Output{Text: "ok"}, false, `not contain "ok"`},
		{"icontains pass", Assertion{Type: "icontains", Value: "OK"}, Output{Text: "ok"}, true, ""},
		{"contains is case sensitive", Assertion{Type: "contains", Value: "OK"}, Output{Text: "ok"}, false, ""},
		{"contains-any pass", Assertion{Type: "contains-any", Values: []string{"x", "ok"}}, Output{Text: "ok"}, true, ""},
		{"contains-any fail", Assertion{Type: "contains-any", Values: []string{"x", "y"}}, Output{Text: "ok"}, false, `one of "x, y"`},
		{"contains-any comma string", Assertion{Type: "contains-any", Value: "x, ok"}, Output{Text: "ok"}, true, ""},
		{"contains-all fail", Assertion{Type: "contains-all", Values: []string{"a", "b"}}, Output{Text: "a"}, false, "Missing: [b]"},
		{"icontains-all pass", Assertion{Type: "icontains-all", Values: []string{"A", "B"}}, Output{Text: "a b"}, true, ""},
		{"regex pass", Assertion{Type: "regex", Value: `^\d+$`}, Output{Text: "123"}, true, ""},
		{"regex fail", Assertion{Type: "regex", Value: `^\d+$`}, Output{Text: "x"}, false, `match regex "^\d+$"`},
		{"regex invalid", Assertion{Type: "regex", Value: `(`}, Output{Text: "x"}, false, "Invalid regex pattern"},
		{"is-json pass", Assertion{Type: "is-json"}, Output{Text: `{"a":1}`}, true, ""},
		{"json-valid alias fail", Assertion{Type: "json-valid"}, Output{Text: `{a`}, false, "be valid JSON"},
		{"not-is-json fail", Assertion{Type: "not-is-json"}, Output{Text: `[]`}, false, "not be valid JSON"},
		{"cost pass", Assertion{Type: "cost", Threshold: f(1)}, Output{CostUSD: f(0.5)}, true, ""},
		{"cost at the threshold passes", Assertion{Type: "cost", Threshold: f(1)}, Output{CostUSD: f(1)}, true, ""},
		{"cost fail", Assertion{Type: "cost", Threshold: f(1)}, Output{CostUSD: f(2)}, false, "greater than threshold 1"},
		{"not-cost fail", Assertion{Type: "not-cost", Threshold: f(1)}, Output{CostUSD: f(0.5)}, false, "less than or equal to threshold"},
		{"latency pass", Assertion{Type: "latency", Threshold: f(100)}, Output{LatencyMs: f(99)}, true, ""},
		{"latency fail", Assertion{Type: "latency", Threshold: f(100)}, Output{LatencyMs: f(101)}, false, "Latency 101ms is greater than threshold 100ms"},
		{"tool-used pass", Assertion{Type: "trajectory:tool-used", Values: []string{"read"}}, Output{Tools: tools("read", "write")}, true, "Observed required tool(s): read"},
		{"tool-used fail", Assertion{Type: "trajectory:tool-used", Values: []string{"bash"}}, Output{Tools: tools("read")}, false, "Missing required tool(s): bash"},
		{"tool-used glob is case blind", Assertion{Type: "tool-used", Value: "RE*"}, Output{Tools: tools("read")}, true, ""},
		{"tool-used count fail", Assertion{Type: "tool-used", Value: "read", Min: n(2)}, Output{Tools: tools("read")}, false, "expected at least 2"},
		{"tool-used max only still needs one call", Assertion{Type: "tool-used", Value: "read", Max: n(3)}, Output{Tools: tools("write")}, false, "expected 1-3"},
		{"tool-used count range", Assertion{Type: "tool-used", Value: "read", Min: n(1), Max: n(1)}, Output{Tools: tools("read", "read")}, false, "expected 1-1"},
		{"not-tool-used fail", Assertion{Type: "not-tool-used", Values: []string{"bash"}}, Output{Tools: tools("bash")}, false, "Forbidden tool(s) were used: bash"},
		{"not-tool-used pass", Assertion{Type: "not-tool-used", Values: []string{"bash"}}, Output{Tools: tools("read")}, true, "were not used"},
		{"tool-sequence in order pass", Assertion{Type: "tool-sequence", Values: []string{"a", "c"}}, Output{Tools: tools("a", "b", "c")}, true, "in order"},
		{"tool-sequence in order fail", Assertion{Type: "tool-sequence", Values: []string{"c", "a"}}, Output{Tools: tools("a", "b", "c")}, false, `"a" was not observed in order`},
		{"tool-sequence exact fail", Assertion{Type: "tool-sequence", Values: []string{"a", "c"}, Mode: "exact"}, Output{Tools: tools("a", "b", "c")}, false, "exact tool sequence"},
		{"tool-sequence exact pass", Assertion{Type: "tool-sequence", Values: []string{"a", "b"}, Mode: "exact"}, Output{Tools: tools("a", "b")}, true, ""},
		{"not-tool-sequence fail", Assertion{Type: "not-tool-sequence", Values: []string{"a"}}, Output{Tools: tools("a")}, false, "Forbidden tool sequence was observed"},
		{"step-count pass", Assertion{Type: "trajectory:step-count", Max: n(2)}, Output{Tools: tools("a", "b")}, true, "expected at most 2"},
		{"step-count fail max", Assertion{Type: "step-count", Max: n(1)}, Output{Tools: tools("a", "b")}, false, "Matched 2 trajectory step(s)"},
		{"step-count fail min", Assertion{Type: "step-count", Min: n(3)}, Output{Tools: tools("a", "b")}, false, "expected at least 3"},
		{"step-count by name", Assertion{Type: "step-count", Value: "a", Max: n(1)}, Output{Tools: tools("a", "b", "a")}, false, "pattern=a"},
		{"not-step-count fail", Assertion{Type: "not-step-count", Max: n(5)}, Output{Tools: tools("a")}, false, "forbidden range"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := RunOne(tt.a, tt.out)
			if err != nil {
				t.Fatal(err)
			}
			if got.Pass != tt.pass {
				t.Fatalf("pass = %v, want %v (%s)", got.Pass, tt.pass, got.Reason)
			}
			if wantScore := map[bool]float64{true: 1, false: 0}[tt.pass]; got.Score != wantScore {
				t.Fatalf("score = %v, want %v", got.Score, wantScore)
			}
			if !strings.Contains(got.Reason, tt.why) {
				t.Fatalf("reason %q lacks %q", got.Reason, tt.why)
			}
		})
	}
}

func TestIsRefusal(t *testing.T) {
	tests := []struct {
		name string
		a    Assertion
		out  Output
		pass bool
		why  string
	}{
		{"prefix refusal", Assertion{Type: "is-refusal"}, Output{Text: "I cannot do that."}, true, "Assertion passed"},
		{"substring refusal", Assertion{Type: "is-refusal"}, Output{Text: "Well, as an AI I decline"}, true, ""},
		{"word boundary: airbnb is no refusal", Assertion{Type: "is-refusal"}, Output{Text: "as an airbnb host"}, false, "be a refusal"},
		{"phrase inside a longer word is no refusal", Assertion{Type: "is-refusal"}, Output{Text: "alas an ai"}, false, ""},
		{"curly apostrophe", Assertion{Type: "is-refusal"}, Output{Text: "I’m sorry, no."}, true, ""},
		{"plain answer is not a refusal", Assertion{Type: "is-refusal"}, Output{Text: "Here is the file."}, false, "Expected output to be a refusal"},
		{"inverse plain answer passes", Assertion{Type: "not-is-refusal"}, Output{Text: "Here is the file."}, true, ""},
		{"inverse refusal fails", Assertion{Type: "not-is-refusal"}, Output{Text: "I will not."}, false, "Expected output to not be a refusal"},
		{"provider flag wins", Assertion{Type: "is-refusal"}, Output{Text: "sure thing", ProviderRefusal: true}, true, "Provider reported a refusal"},
		{"provider flag inverse", Assertion{Type: "not-is-refusal"}, Output{Text: "sure", ProviderRefusal: true}, false, "Expected output to not be a refusal"},
		{"provider flag ignored when transformed", Assertion{Type: "is-refusal"}, Output{Text: "sure", ProviderRefusal: true, Transformed: true}, false, ""},
		{"no output counts as refusal", Assertion{Type: "is-refusal"}, Output{}, true, "Empty response treated as refusal"},
		{"whitespace counts as refusal", Assertion{Type: "is-refusal"}, Output{Text: "  \n"}, true, "Empty response"},
		{"empty inverse fails", Assertion{Type: "not-is-refusal"}, Output{}, false, "Expected output to not be a refusal"},
		{"structured output is serialised", Assertion{Type: "is-refusal"}, Output{Structured: map[string]any{"msg": "I cannot help"}}, true, ""},
		{"structured non refusal", Assertion{Type: "not-is-refusal"}, Output{Structured: map[string]any{"ok": 1}}, true, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := RunOne(tt.a, tt.out)
			if err != nil {
				t.Fatal(err)
			}
			if got.Pass != tt.pass || !strings.Contains(got.Reason, tt.why) {
				t.Fatalf("got pass=%v reason=%q, want pass=%v containing %q", got.Pass, got.Reason, tt.pass, tt.why)
			}
		})
	}
}

func TestAssertionErrors(t *testing.T) {
	tests := []struct {
		name string
		a    Assertion
		out  Output
	}{
		{"unknown type", Assertion{Type: "levenshtein"}, Output{}},
		{"contains needs a value", Assertion{Type: "contains"}, Output{Text: "x"}},
		{"contains-any needs values", Assertion{Type: "contains-any"}, Output{Text: "x"}},
		{"regex needs value", Assertion{Type: "regex"}, Output{}},
		{"cost needs threshold", Assertion{Type: "cost"}, Output{CostUSD: f(1)}},
		{"cost needs a reported cost", Assertion{Type: "cost", Threshold: f(1)}, Output{}},
		{"latency needs threshold", Assertion{Type: "latency"}, Output{LatencyMs: f(1)}},
		{"latency needs a reading", Assertion{Type: "latency", Threshold: f(1)}, Output{}},
		{"tool-used needs a tool", Assertion{Type: "tool-used"}, Output{}},
		{"tool-sequence needs steps", Assertion{Type: "tool-sequence"}, Output{}},
		{"step-count needs a bound", Assertion{Type: "step-count"}, Output{}},
		{"assert-set cannot run alone", Assertion{Type: "assert-set"}, Output{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := RunOne(tt.a, tt.out); err == nil {
				t.Fatal("want an error")
			}
		})
	}
}

func TestCostMetricOnlyReportsTheCost(t *testing.T) {
	got, err := RunOne(Assertion{Type: "cost", Metric: "cost", Weight: f(0)}, Output{CostUSD: f(0.25)})
	if err != nil || !got.Pass || got.Score != 0.25 {
		t.Fatalf("got %+v %v", got, err)
	}
	if _, err := RunOne(Assertion{Type: "cost", Metric: "cost", Weight: f(0)}, Output{CostUSD: f(-1)}); err == nil {
		t.Fatal("negative cost must be an error")
	}
}

func TestScorecardAggregation(t *testing.T) {
	yes := Output{Text: "ok"}
	tests := []struct {
		name      string
		asserts   []Assertion
		threshold *float64
		pass      bool
		score     float64
		reason    string
		named     map[string]float64
	}{
		{"no assertions", nil, nil, true, 1, "No assertions", nil},
		{"all pass", []Assertion{{Type: "contains", Value: "ok"}, {Type: "regex", Value: "o"}}, nil, true, 1, "All assertions passed", map[string]float64{}},
		{"one failure fails the test", []Assertion{{Type: "contains", Value: "ok"}, {Type: "contains", Value: "zz"}}, nil, false, 0.5, `Expected output to contain "zz"`, map[string]float64{}},
		{"weights skew the score", []Assertion{{Type: "contains", Value: "ok", Weight: f(3)}, {Type: "contains", Value: "zz", Weight: f(1)}}, nil, false, 0.75, "", map[string]float64{}},
		{"threshold overrides a failure", []Assertion{{Type: "contains", Value: "ok", Weight: f(3)}, {Type: "contains", Value: "zz"}}, f(0.7), true, 0.75, "Aggregate score 0.75 ≥ 0.7 threshold", map[string]float64{}},
		{"threshold can fail all-pass", []Assertion{{Type: "contains", Value: "ok"}}, f(1.5), false, 1, "Aggregate score 1.00 < 1.5 threshold", map[string]float64{}},
		{"zero weight measures only", []Assertion{{Type: "contains", Value: "ok"}, {Type: "contains", Value: "zz", Weight: f(0), Metric: "soft"}}, nil, true, 1, "All assertions passed", map[string]float64{"soft": 0}},
		{"named metrics average", []Assertion{{Type: "contains", Value: "ok", Metric: "m"}, {Type: "contains", Value: "zz", Metric: "m"}}, f(0), true, 0.5, "", map[string]float64{"m": 0.5}},
		{"all weights zero scores zero", []Assertion{{Type: "contains", Value: "ok", Weight: f(0)}}, nil, true, 0, "", map[string]float64{}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Evaluate(tt.asserts, yes, tt.threshold)
			if err != nil {
				t.Fatal(err)
			}
			if got.Pass != tt.pass || math.Abs(got.Score-tt.score) > 1e-9 || !strings.Contains(got.Reason, tt.reason) {
				t.Fatalf("got pass=%v score=%v reason=%q", got.Pass, got.Score, got.Reason)
			}
			for k, v := range tt.named {
				if math.Abs(got.NamedScores[k]-v) > 1e-9 {
					t.Fatalf("named %s = %v, want %v", k, got.NamedScores[k], v)
				}
			}
		})
	}
}

func TestZeroWeightMetricCountsAsWeightOneInItsMetric(t *testing.T) {
	got, err := Evaluate([]Assertion{
		{Type: "contains", Value: "ok", Metric: "m", Weight: f(0)},
		{Type: "contains", Value: "zz", Metric: "m", Weight: f(0)},
	}, Output{Text: "ok"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.NamedScores["m"] != 0.5 || got.NamedScoreWeights["m"] != 2 {
		t.Fatalf("got %v %v", got.NamedScores, got.NamedScoreWeights)
	}
}

func TestAssertSet(t *testing.T) {
	out := Output{Text: "ok"}
	set := func(th *float64, w *float64, metric string, subs ...Assertion) Assertion {
		return Assertion{Type: "assert-set", Threshold: th, Weight: w, Metric: metric, Assert: subs}
	}
	pass, fail := Assertion{Type: "contains", Value: "ok"}, Assertion{Type: "contains", Value: "zz"}
	tests := []struct {
		name    string
		asserts []Assertion
		pass    bool
		score   float64
		named   map[string]float64
	}{
		{"set below its threshold fails the test", []Assertion{set(f(0.9), nil, "", pass, fail)}, false, 0.5, nil},
		{"set at its threshold passes though a member failed", []Assertion{set(f(0.5), nil, "", pass, fail)}, true, 0.5, nil},
		{"set weight applies in the parent", []Assertion{pass, set(f(0.5), f(3), "", fail)}, false, 0.25, nil},
		{"set metric names the set score", []Assertion{set(f(0), nil, "grp", pass, fail)}, true, 0.5, map[string]float64{"grp": 0.5}},
		{"set member metrics bubble up", []Assertion{set(nil, nil, "", Assertion{Type: "contains", Value: "ok", Metric: "inner"})}, true, 1, map[string]float64{"inner": 1}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := Evaluate(tt.asserts, out, nil)
			if err != nil {
				t.Fatal(err)
			}
			if got.Pass != tt.pass || math.Abs(got.Score-tt.score) > 1e-9 {
				t.Fatalf("got pass=%v score=%v reason=%q", got.Pass, got.Score, got.Reason)
			}
			for k, v := range tt.named {
				if math.Abs(got.NamedScores[k]-v) > 1e-9 {
					t.Fatalf("named %s = %v, want %v (%v)", k, got.NamedScores[k], v, got.NamedScores)
				}
			}
		})
	}
}

func TestNonFiniteWeightFailsAggregation(t *testing.T) {
	got, err := Evaluate([]Assertion{{Type: "contains", Value: "ok", Weight: f(math.MaxFloat64)}, {Type: "contains", Value: "ok", Weight: f(math.MaxFloat64)}}, Output{Text: "ok"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if got.Pass || got.Score != 0 || !strings.Contains(got.Reason, "must remain finite") {
		t.Fatalf("got %+v", got)
	}
}

func TestEvaluateReturnsAssertionErrors(t *testing.T) {
	if _, err := Evaluate([]Assertion{{Type: "nope"}}, Output{}, nil); err == nil {
		t.Fatal("want error")
	}
	if _, err := Evaluate([]Assertion{{Type: "assert-set", Assert: []Assertion{{Type: "nope"}}}}, Output{}, nil); err == nil {
		t.Fatal("want error from inside a set")
	}
}

func TestZeroWeightAssertionNeverFailsTheTest(t *testing.T) {
	got, err := Evaluate([]Assertion{{Type: "contains", Value: "zz", Weight: f(0)}}, Output{Text: "ok"}, nil)
	if err != nil || !got.Pass {
		t.Fatalf("got %+v %v", got, err)
	}
	if got.Components[0].Pass != true {
		t.Fatal("component of a zero weight assertion must read as pass")
	}
}
