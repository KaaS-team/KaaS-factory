package price

import "testing"

func usageTier(name string, prio int, pattern, op string, v float64, cs bool) Tier {
	return Tier{ID: name, Name: name, Priority: prio, Conditions: []Condition{{Pattern: pattern, Operator: op, Value: v, CaseSensitive: cs}}}
}

func TestMatchTier(t *testing.T) {
	def := Tier{ID: "d", Name: "Standard", IsDefault: true}
	attr := Tier{ID: "a", Name: "Fast", Priority: 1, Conditions: []Condition{{Source: "model_parameters", Key: "speed", Operator: "in", Values: []string{"fast"}}}}
	cases := []struct {
		name  string
		tiers []Tier
		usage Usage
		attrs matchAttrs
		want  string // tier id, "" for nil
	}{
		{"gt hit", []Tier{def, usageTier("big", 1, "^input", "gt", 100, false)}, Usage{"input": 101}, matchAttrs{}, "big"},
		{"gt equal misses", []Tier{def, usageTier("big", 1, "^input", "gt", 100, false)}, Usage{"input": 100}, matchAttrs{}, "d"},
		{"gte", []Tier{def, usageTier("x", 1, "^input", "gte", 100, false)}, Usage{"input": 100}, matchAttrs{}, "x"},
		{"lt", []Tier{def, usageTier("x", 1, "^input", "lt", 100, false)}, Usage{"input": 99}, matchAttrs{}, "x"},
		{"lte", []Tier{def, usageTier("x", 1, "^input", "lte", 100, false)}, Usage{"input": 100}, matchAttrs{}, "x"},
		{"eq", []Tier{def, usageTier("x", 1, "^input", "eq", 100, false)}, Usage{"input": 100}, matchAttrs{}, "x"},
		{"neq", []Tier{def, usageTier("x", 1, "^input", "neq", 100, false)}, Usage{"input": 99}, matchAttrs{}, "x"},
		{"unknown operator fails", []Tier{def, usageTier("x", 1, "^input", "between", 100, false)}, Usage{"input": 100}, matchAttrs{}, "d"},
		{"sums every matching key", []Tier{def, usageTier("x", 1, "input", "gt", 100, false)}, Usage{"input": 60, "input_cache_read": 50, "output": 999}, matchAttrs{}, "x"},
		{"case insensitive default", []Tier{def, usageTier("x", 1, "^INPUT", "gt", 1, false)}, Usage{"input": 5}, matchAttrs{}, "x"},
		{"case sensitive misses", []Tier{def, usageTier("x", 1, "^INPUT", "gt", 1, true)}, Usage{"input": 5}, matchAttrs{}, "d"},
		{"bad pattern fails safe", []Tier{def, usageTier("x", 1, "(", "gt", 1, false)}, Usage{"input": 5}, matchAttrs{}, "d"},
		{"empty conditions never match", []Tier{def, {ID: "e", Priority: 1}}, Usage{"input": 5}, matchAttrs{}, "d"},
		{"lowest priority wins", []Tier{usageTier("p2", 2, "input", "gt", 1, false), usageTier("p1", 1, "input", "gt", 1, false), def}, Usage{"input": 5}, matchAttrs{}, "p1"},
		{"attribute hit", []Tier{def, attr}, Usage{"input": 1}, matchAttrs{params: map[string]string{"speed": "fast"}}, "a"},
		{"attribute value miss", []Tier{def, attr}, Usage{"input": 1}, matchAttrs{params: map[string]string{"speed": "slow"}}, "d"},
		{"attribute key missing", []Tier{def, attr}, Usage{"input": 1}, matchAttrs{}, "d"},
		{"metadata is a separate source", []Tier{def, attr}, Usage{"input": 1}, matchAttrs{meta: map[string]string{"speed": "fast"}}, "d"},
		{"all conditions must pass", []Tier{def, {ID: "m", Priority: 1, Conditions: append(attr.Conditions, Condition{Pattern: "input", Operator: "gt", Value: 10})}}, Usage{"input": 1}, matchAttrs{params: map[string]string{"speed": "fast"}}, "d"},
		{"no default and no match", []Tier{usageTier("x", 1, "input", "gt", 10, false)}, Usage{"input": 1}, matchAttrs{}, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := matchTier(c.tiers, c.usage, c.attrs)
			switch {
			case c.want == "" && got != nil:
				t.Fatalf("want no tier, got %q", got.ID)
			case c.want != "" && (got == nil || got.ID != c.want):
				t.Fatalf("want tier %q, got %+v", c.want, got)
			}
		})
	}
}
