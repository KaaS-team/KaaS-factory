package eval

import (
	"math"
	"testing"
)

// Reference values from tests/scorer/test_metric.py (scipy binomtest proportion_ci, "wilson").
func TestWilsonReferenceValues(t *testing.T) {
	tests := []struct {
		k, n         int
		level        float64
		lower, upper float64
	}{
		{8, 10, 0.95, 0.4901624715366418, 0.9433178485456248},
		{0, 20, 0.95, 0.0, 0.16112515805281935},
		{20, 20, 0.95, 0.8388748419471808, 1.0},
		{5, 50, 0.90, 0.04952903447744518, 0.1915375141515709},
		{5, 50, 0.99, 0.03399088377841833, 0.2597307895956841},
		{49, 100, 0.95, 0.3942199893044114, 0.5865198806597284},
		{1, 1, 0.95, 0.20654931437723745, 1.0},
	}
	for _, tc := range tests {
		lo, hi, err := Wilson(float64(tc.k), tc.n, tc.level)
		if err != nil {
			t.Fatal(err)
		}
		if math.Abs(lo-tc.lower) > 1e-9 || math.Abs(hi-tc.upper) > 1e-9 {
			t.Errorf("%d/%d at %v: got %v %v want %v %v", tc.k, tc.n, tc.level, lo, hi, tc.lower, tc.upper)
		}
	}
}

func TestWilsonEdges(t *testing.T) {
	if lo, hi, err := Wilson(0, 0, 0.95); err != nil || lo != 0 || hi != 0 {
		t.Fatalf("empty: %v %v %v", lo, hi, err)
	}
	for _, level := range []float64{0, 1, 1.5, -0.1} {
		if _, _, err := Wilson(1, 2, level); err == nil {
			t.Errorf("level %v accepted", level)
		}
	}
	for _, sum := range []float64{-0.5, 3} {
		if _, _, err := Wilson(sum, 2, 0.95); err == nil {
			t.Errorf("sum %v accepted for n=2", sum)
		}
	}
	if lo, _, _ := Wilson(0, 20, 0.95); lo != 0 {
		t.Errorf("lower bound %v is not clamped to 0", lo)
	}
	if _, hi, _ := Wilson(20, 20, 0.95); hi != 1 {
		t.Errorf("upper bound %v is not clamped to 1", hi)
	}
	lo, hi, _ := Wilson(10, 20, 0.95)
	if math.Abs(lo-(1-hi)) > 1e-12 {
		t.Errorf("not symmetric at half: %v %v", lo, hi)
	}
	nl, nh, _ := Wilson(15, 30, 0.80)
	wl, wh, _ := Wilson(15, 30, 0.99)
	if wh-wl <= nh-nl {
		t.Error("higher level must widen the interval")
	}
	// graded scores: 0, .5, .5, 1 sum to 2 of 4
	if lo, hi, _ := Wilson(2, 4, 0.95); !(lo > 0 && lo < 0.5 && hi > 0.5 && hi < 1) {
		t.Errorf("graded: %v %v", lo, hi)
	}
}
