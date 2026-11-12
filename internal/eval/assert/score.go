// Ported from promptfoo/promptfoo@4f6710156d4a8426b852cf3af2b54c593a0e5177 src/assertions/assertionsResult.ts
// Also ported from runAssertions in src/assertions/index.ts at the same SHA. MIT, see THIRD_PARTY_NOTICES.md.
// Token accounting, guardrail handling and custom scoring functions are not ported.

package assert

import (
	"fmt"
	"math"
)

func finite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }

// weightedScore divides total by weight; a non-finite input stays NaN so it cannot hide overflow.
func weightedScore(total, weight float64) float64 {
	if !finite(total) || !finite(weight) {
		return math.NaN()
	}
	if weight > 0 {
		return total / weight
	}
	return 0
}

// aggregate accumulates weighted assertion results for one test or one assert-set.
type aggregate struct {
	threshold            *float64
	set                  *Assertion
	totalScore, totalWt  float64
	failed               bool
	failedReason         string
	components           []Result
	namedScores, namedWt map[string]float64
}

func newAggregate(threshold *float64, set *Assertion) *aggregate {
	return &aggregate{threshold: threshold, set: set, namedScores: map[string]float64{}, namedWt: map[string]float64{}}
}

func (g *aggregate) add(r Result, metric string, weight float64) {
	g.totalScore += r.Score * weight
	g.totalWt += weight
	g.components = append(g.components, r)
	// A zero weight assertion counts as 1 inside its own metric so the measure is still averaged.
	mw := weight
	if weight == 0 {
		mw = 1
	}
	if metric != "" {
		g.namedScores[metric] += r.Score * mw
		g.namedWt[metric] += mw
	}
	for name, score := range r.NamedScores {
		if name == metric {
			continue
		}
		in, ok := r.NamedScoreWeights[name]
		if !ok {
			in = 1
		}
		g.namedScores[name] += score * in * mw
		g.namedWt[name] += in * mw
	}
	if !r.Pass {
		g.failed, g.failedReason = true, r.Reason
	}
}

func (g *aggregate) result() Result {
	score := weightedScore(g.totalScore, g.totalWt)
	pass, reason := !g.failed, "All assertions passed"
	if g.failed {
		reason = g.failedReason
	}
	if g.threshold != nil && !math.IsNaN(*g.threshold) {
		// A numeric threshold overrides the pass or fail of the individual assertions.
		pass = score >= *g.threshold
		cmp := "<"
		if pass {
			cmp = "≥"
		}
		reason = fmt.Sprintf("Aggregate score %.2f %s %v threshold", score, cmp, *g.threshold)
	}
	var flat []Result
	for _, c := range g.components {
		flat = append(flat, c)
		flat = append(flat, c.Components...)
	}
	named := map[string]float64{}
	bad := false
	for k, v := range g.namedScores {
		named[k] = weightedScore(v, g.namedWt[k])
		bad = bad || !finite(named[k]) || !finite(g.namedWt[k])
	}
	res := Result{Type: "assert-set", Pass: pass, Score: score, Reason: reason, NamedScores: named, NamedScoreWeights: g.namedWt, Components: flat}
	if !finite(score) || bad {
		res.Pass, res.Score = false, 0
		res.Reason = "Assertion aggregation error: scores or weights must remain finite"
		res.NamedScores, res.NamedScoreWeights = map[string]float64{}, map[string]float64{}
	}
	return res
}

func weightOf(a Assertion) float64 {
	if a.Weight == nil {
		return 1
	}
	return *a.Weight
}

// Evaluate grades a test: every assertion runs, assert-sets aggregate on their
// own threshold first, and the weighted mean is the test score. An empty list
// passes with score 1. A threshold, when given, replaces the pass or fail of
// the individual assertions. An error means an assertion was malformed.
func Evaluate(asserts []Assertion, o Output, threshold *float64) (Result, error) {
	if len(asserts) == 0 {
		return Result{Pass: true, Score: 1, Reason: "No assertions"}, nil
	}
	main := newAggregate(threshold, nil)
	for _, a := range asserts {
		if a.Type != "assert-set" {
			r, err := RunOne(a, o)
			if err != nil {
				return Result{}, err
			}
			main.add(r, a.Metric, weightOf(a))
			continue
		}
		sub := newAggregate(a.Threshold, &a)
		for _, m := range a.Assert {
			r, err := RunOne(m, o)
			if err != nil {
				return Result{}, err
			}
			sub.add(r, m.Metric, weightOf(m))
		}
		main.add(sub.result(), a.Metric, weightOf(a))
	}
	return main.result(), nil
}
