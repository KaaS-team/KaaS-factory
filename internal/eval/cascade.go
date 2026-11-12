// Ported from UKGovernmentBEIS/inspect_ai@26f6d05 src/inspect_ai/scorer/_cascade.py

package eval

import (
	"context"
	"math"
)

// Stage is one scorer in a cascade. Score returns its value, and ok false when it declines.
type Stage struct {
	Name  string
	Score func(ctx context.Context) (value float64, ok bool, err error)
}

// Decision is what Cascade settled on: the value, and the stage that decided it.
// Scored is false when every stage declined or returned NaN.
type Decision struct {
	Value     float64
	DecidedBy string
	Scored    bool
}

// Cascade runs stages in order and stops at the first whose value is at least threshold.
// A declined or NaN stage is skipped. When none settles, the last stage that scored decides.
func Cascade(ctx context.Context, threshold float64, stages []Stage) (Decision, error) {
	var d Decision
	for _, s := range stages {
		v, ok, err := s.Score(ctx)
		if err != nil {
			return Decision{}, err
		}
		if !ok || math.IsNaN(v) {
			continue
		}
		d = Decision{Value: v, DecidedBy: s.Name, Scored: true}
		if v >= threshold {
			break
		}
	}
	return d, nil
}
