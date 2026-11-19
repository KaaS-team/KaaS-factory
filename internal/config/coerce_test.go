package config

import (
	"reflect"
	"testing"
	"time"
)

// TestCoerceTable pins what each key kind accepts and rejects.
func TestCoerceTable(t *testing.T) {
	tests := []struct {
		name string
		sp   spec
		raw  any
		want any
		err  string
	}{
		{"string ok", spec{kind: kString}, "x", "x", ""},
		{"string bad", spec{kind: kString}, 3, nil, "expected a string, got 3"},
		{"int from string", spec{kind: kInt}, "4", 4, ""},
		{"int fraction", spec{kind: kInt}, 1.5, nil, "expected a whole number, got 1.5"},
		{"int below min", spec{kind: kInt, min: 2}, 1, nil, "expected at least 2, got 1"},
		{"float ok", spec{kind: kFloat}, "2.5", 2.5, ""},
		{"float negative", spec{kind: kFloat}, -1, nil, "expected a number of 0 or more, got -1"},
		{"duration value", spec{kind: kDuration}, time.Minute, time.Minute, ""},
		{"duration string", spec{kind: kDuration}, "30m", 30 * time.Minute, ""},
		{"duration zero", spec{kind: kDuration}, "0s", nil, `expected a positive duration such as 30m, got "0s"`},
		{"duration type", spec{kind: kDuration}, 5, nil, "expected a duration such as 30m, got 5"},
		{"list csv", spec{kind: kList}, "a, b,,c", []string{"a", "b", "c"}, ""},
		{"list any", spec{kind: kList}, []any{"a"}, []string{"a"}, ""},
		{"list bad entry", spec{kind: kList}, []any{1}, nil, "expected a list of strings, got entry 1"},
		{"bool string", spec{kind: kBool}, "true", true, ""},
		{"bool bad", spec{kind: kBool}, "maybe", nil, "expected true or false, got maybe"},
		{"role ok", spec{kind: kRole}, "write", "write", ""},
		{"role bad", spec{kind: kRole}, "boss", nil, "expected one of read, triage, write, maintain, admin, got boss"},
		{"risk ok", spec{kind: kRisk}, "low", "low", ""},
		{"risk bad", spec{kind: kRisk}, 1, nil, "expected one of low, medium, high, got 1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := coerce(tc.sp, tc.raw)
			if tc.err != "" {
				if err == nil || err.Error() != tc.err {
					t.Fatalf("err = %v, want %q", err, tc.err)
				}
				return
			}
			if err != nil || !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %#v, %v; want %#v", got, err, tc.want)
			}
		})
	}
}
