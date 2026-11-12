package eval

import (
	"context"
	"errors"
	"math"
	"testing"
)

// stage records that it ran, then returns a fixed result.
func stage(name string, calls *[]string, v float64, ok bool) Stage {
	return Stage{Name: name, Score: func(context.Context) (float64, bool, error) {
		*calls = append(*calls, name)
		return v, ok, nil
	}}
}

// Cases ported from tests/scorer/test_cascade.py: CORRECT is 1, INCORRECT 0, PARTIAL 0.5,
// a declined stage is ok=false and an unscored stage is NaN.
func TestCascade(t *testing.T) {
	nan := math.NaN()
	tests := []struct {
		name      string
		threshold float64
		stages    []struct {
			v  float64
			ok bool
		}
		wantCalls  []string
		wantValue  float64
		wantBy     string
		wantScored bool
	}{
		{"first correct short circuits", 1, []struct {
			v  float64
			ok bool
		}{{1, true}, {1, true}}, []string{"s0"}, 1, "s0", true},
		{"falls through to settling stage", 1, []struct {
			v  float64
			ok bool
		}{{0, true}, {1, true}}, []string{"s0", "s1"}, 1, "s1", true},
		{"no stage settles returns last scored", 1, []struct {
			v  float64
			ok bool
		}{{0, true}, {0, true}}, []string{"s0", "s1"}, 0, "s1", true},
		{"declining stage is skipped", 1, []struct {
			v  float64
			ok bool
		}{{0, false}, {0, true}}, []string{"s0", "s1"}, 0, "s1", true},
		{"unscored stage is skipped", 1, []struct {
			v  float64
			ok bool
		}{{nan, true}, {1, true}}, []string{"s0", "s1"}, 1, "s1", true},
		{"all declined or unscored is unscored", 1, []struct {
			v  float64
			ok bool
		}{{0, false}, {nan, true}}, []string{"s0", "s1"}, 0, "", false},
		{"threshold lets partial settle", 0.5, []struct {
			v  float64
			ok bool
		}{{0.5, true}, {1, true}}, []string{"s0"}, 0.5, "s0", true},
		{"default threshold: partial does not settle", 1, []struct {
			v  float64
			ok bool
		}{{0.5, true}, {1, true}}, []string{"s0", "s1"}, 1, "s1", true},
		{"no stages is unscored", 1, nil, nil, 0, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			var stages []Stage
			for i, s := range tc.stages {
				stages = append(stages, stage("s"+string(rune('0'+i)), &calls, s.v, s.ok))
			}
			d, err := Cascade(context.Background(), tc.threshold, stages)
			if err != nil {
				t.Fatal(err)
			}
			if len(calls) != len(tc.wantCalls) {
				t.Fatalf("calls %v want %v", calls, tc.wantCalls)
			}
			if d.Scored != tc.wantScored || d.DecidedBy != tc.wantBy || (tc.wantScored && d.Value != tc.wantValue) {
				t.Fatalf("got %+v", d)
			}
		})
	}
}

func TestCascadeStopsOnError(t *testing.T) {
	boom := errors.New("boom")
	var calls []string
	_, err := Cascade(context.Background(), 1, []Stage{
		{Name: "a", Score: func(context.Context) (float64, bool, error) { return 0, false, boom }},
		stage("b", &calls, 1, true),
	})
	if !errors.Is(err, boom) || len(calls) != 0 {
		t.Fatalf("err %v calls %v", err, calls)
	}
}
