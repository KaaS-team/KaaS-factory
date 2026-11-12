// Ported from UKGovernmentBEIS/inspect_ai@26f6d05 src/inspect_ai/scorer/_metrics/std.py

package eval

import (
	"fmt"
	"math"
)

// Wilson returns the two-sided Wilson score interval at level (for example 0.95) for a
// proportion whose scores sum to sum over n samples. Scores must lie in [0, 1], so sum is in [0, n].
// With no samples both bounds are 0.
func Wilson(sum float64, n int, level float64) (lower, upper float64, err error) {
	if !(level > 0 && level < 1) {
		return 0, 0, fmt.Errorf("eval: wilson level must be in (0, 1), got %v", level)
	}
	if sum < 0 || sum > float64(n) {
		return 0, 0, fmt.Errorf("eval: wilson sum %v is outside 0..%d: every score must be between 0 and 1", sum, n)
	}
	if n == 0 {
		return 0, 0, nil
	}
	z := math.Sqrt2 * math.Erfinv(level)
	nf := float64(n)
	p := sum / nf
	denom := 1 + z*z/nf
	center := (p + z*z/(2*nf)) / denom
	half := z * math.Sqrt(p*(1-p)/nf+z*z/(4*nf*nf)) / denom
	return math.Max(center-half, 0), math.Min(center+half, 1), nil
}
