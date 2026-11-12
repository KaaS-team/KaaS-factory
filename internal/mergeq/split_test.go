package mergeq

import (
	"fmt"
	"reflect"
	"testing"
)

func entries(n int, single ...int) []Entry {
	var out []Entry
	for i := 1; i <= n; i++ {
		out = append(out, Entry{ID: fmt.Sprint(i), Head: fmt.Sprintf("h%d", i)})
	}
	for _, s := range single {
		out[s-1].Single = true
	}
	return out
}

func idsOf(es []Entry) []string {
	var out []string
	for _, e := range es {
		out = append(out, e.ID)
	}
	return out
}

// A failed batch of N>1 becomes two child batches of floor(N/2) and the rest; N=1 has no children.
func TestHalve(t *testing.T) {
	tests := []struct {
		n      int
		lo, hi []string
		ok     bool
	}{
		{1, nil, nil, false},
		{2, []string{"1"}, []string{"2"}, true},
		{3, []string{"1"}, []string{"2", "3"}, true},
		{8, []string{"1", "2", "3", "4"}, []string{"5", "6", "7", "8"}, true},
	}
	for _, tc := range tests {
		t.Run(fmt.Sprint("N=", tc.n), func(t *testing.T) {
			lo, hi, ok := Halve(entries(tc.n))
			if ok != tc.ok || !reflect.DeepEqual(idsOf(lo), tc.lo) || !reflect.DeepEqual(idsOf(hi), tc.hi) {
				t.Fatalf("got %v %v %v", idsOf(lo), idsOf(hi), ok)
			}
		})
	}
}

// Single PRs never share a batch: Take stops before one, and a leading one goes alone.
func TestTakeIsolatesSinglePRs(t *testing.T) {
	tests := []struct {
		name string
		es   []Entry
		size int
		want []string
	}{
		{"no singles fills the batch", entries(5), 4, []string{"1", "2", "3", "4"}},
		{"short queue", entries(2), 4, []string{"1", "2"}},
		{"single at front goes alone", entries(3, 1), 4, []string{"1"}},
		{"single in the middle ends the batch before it", entries(4, 3), 4, []string{"1", "2"}},
		{"single after the batch is untouched", entries(5, 5), 4, []string{"1", "2", "3", "4"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := idsOf(Take(tc.es, tc.size)); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
