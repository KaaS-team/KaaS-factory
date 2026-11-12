// Ported from UKGovernmentBEIS/inspect_ai@26f6d05 src/inspect_ai/scorer/_reducer/reducer.py

package eval

import (
	"fmt"
	"math"
	"slices"
)

// PassThreshold is the reduced score at or above which a ticket counts as passed.
const PassThreshold = 0.5

// Reducer folds the scores of one ticket's epochs into one score. Name is mean, max,
// pass_at_k or at_least_k; K applies to the last two. An epoch passes when its score is at least 1.
type Reducer struct {
	Name string
	K    int
}

// ParseReducer validates a reducer name against the epoch count. The empty name means mean.
func ParseReducer(name string, k, epochs int) (Reducer, error) {
	switch name {
	case "", "mean":
		return Reducer{Name: "mean"}, nil
	case "max":
		return Reducer{Name: "max"}, nil
	case "pass_at_k", "at_least_k":
		if k < 1 || k > epochs {
			return Reducer{}, fmt.Errorf("eval: reducer %s needs 1 <= k <= epochs (%d), got k=%d", name, epochs, k)
		}
		return Reducer{Name: name, K: k}, nil
	}
	return Reducer{}, fmt.Errorf("eval: unknown reducer %q (mean, max, pass_at_k, at_least_k)", name)
}

// Reduce returns the reduced score, or NaN when no epoch scored or pass_at_k has fewer than K scored epochs.
func (r Reducer) Reduce(scores []float64) float64 {
	var vs []float64
	for _, s := range scores {
		if !math.IsNaN(s) {
			vs = append(vs, s)
		}
	}
	if len(vs) == 0 {
		return math.NaN()
	}
	switch r.Name {
	case "max":
		return slices.Max(vs)
	case "at_least_k":
		if correct(vs) >= r.K {
			return 1
		}
		return 0
	case "pass_at_k":
		total, c := len(vs), correct(vs)
		if total < r.K {
			return math.NaN()
		}
		prod := 1.0
		for i := total - c + 1; i <= total; i++ {
			prod *= 1 - float64(r.K)/float64(i)
		}
		return 1 - prod
	}
	var sum float64
	for _, v := range vs {
		sum += v
	}
	return sum / float64(len(vs))
}

func correct(vs []float64) int {
	n := 0
	for _, v := range vs {
		if v >= 1 {
			n++
		}
	}
	return n
}
