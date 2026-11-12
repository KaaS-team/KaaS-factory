package eval

import (
	"math"
	"testing"
)

func TestReducers(t *testing.T) {
	nan := math.NaN()
	tests := []struct {
		name   string
		r      Reducer
		scores []float64
		want   float64
	}{
		{"mean", Reducer{Name: "mean"}, []float64{1, 0, 0, 1}, 0.5},
		{"mean skips unscored", Reducer{Name: "mean"}, []float64{1, nan, 0}, 0.5},
		{"mean of nothing is nan", Reducer{Name: "mean"}, []float64{nan}, nan},
		{"max", Reducer{Name: "max"}, []float64{0, 0.5, 0}, 0.5},
		{"max of nothing is nan", Reducer{Name: "max"}, nil, nan},
		{"at_least_k met", Reducer{Name: "at_least_k", K: 2}, []float64{1, 0, 1}, 1},
		{"at_least_k unmet", Reducer{Name: "at_least_k", K: 3}, []float64{1, 0, 1}, 0},
		{"at_least_k of nothing is nan", Reducer{Name: "at_least_k", K: 1}, nil, nan},
		// pass@k = 1 - prod(1 - k/(n-c+1 .. n)); 1 of 3 correct, k=1 gives 1/3.
		{"pass_at_k one of three", Reducer{Name: "pass_at_k", K: 1}, []float64{1, 0, 0}, 1.0 / 3},
		{"pass_at_k all wrong", Reducer{Name: "pass_at_k", K: 2}, []float64{0, 0, 0}, 0},
		{"pass_at_k enough misses is 1 when n-c<k", Reducer{Name: "pass_at_k", K: 3}, []float64{1, 0, 0}, 1},
		{"pass_at_k fewer than k scored is nan", Reducer{Name: "pass_at_k", K: 4}, []float64{1, 0, 0}, nan},
	}
	for _, tc := range tests {
		got := tc.r.Reduce(tc.scores)
		if math.IsNaN(tc.want) != math.IsNaN(got) || (!math.IsNaN(tc.want) && math.Abs(got-tc.want) > 1e-12) {
			t.Errorf("%s: got %v want %v", tc.name, got, tc.want)
		}
	}
}

func TestParseReducer(t *testing.T) {
	good := map[string]Reducer{
		"":           {Name: "mean"},
		"mean":       {Name: "mean"},
		"max":        {Name: "max"},
		"pass_at_k":  {Name: "pass_at_k", K: 2},
		"at_least_k": {Name: "at_least_k", K: 2},
	}
	for name, want := range good {
		got, err := ParseReducer(name, 2, 3)
		if err != nil || got != want {
			t.Errorf("%q: %+v %v", name, got, err)
		}
	}
	for _, bad := range []struct {
		name string
		k, n int
	}{{"median", 1, 3}, {"pass_at_k", 0, 3}, {"pass_at_k", 4, 3}, {"at_least_k", 5, 3}} {
		if _, err := ParseReducer(bad.name, bad.k, bad.n); err == nil {
			t.Errorf("%+v accepted", bad)
		}
	}
}
