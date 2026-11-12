package price

import (
	"math"
	"math/big"
	"testing"
)

func rat(t *testing.T, s string) Price {
	t.Helper()
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		t.Fatalf("bad rational %q", s)
	}
	return Price{r}
}

// catalogWith builds a one-model catalog with a default tier of the given prices.
func catalogWith(t *testing.T, prices map[string]string, extra ...Tier) *Catalog {
	t.Helper()
	def := Tier{ID: "standard", Name: "Standard", IsDefault: true, Prices: map[string]Price{}}
	for k, v := range prices {
		def.Prices[k] = rat(t, v)
	}
	c, err := New([]Model{{Name: "m", MatchPattern: "(?i)^m$", Tiers: append([]Tier{def}, extra...)}})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func ptr(f float64) *float64 { return &f }

func eqTotal(a, b *float64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return math.Abs(*a-*b) < 1e-9
}

// TestCost ports calculateModelUsageCosts.test.ts case by case.
func TestCost(t *testing.T) {
	cases := []struct {
		name     string
		prices   map[string]string
		in       Input
		total    *float64
		costs    map[string]float64
		unpriced bool
		tierID   string
	}{
		{"infers costs when provided is nil", map[string]string{"input": "0.01", "output": "0.02"}, Input{Usage: Usage{"input": 100, "output": 200}}, ptr(5), map[string]float64{"input": 1, "output": 4, "total": 5}, false, "standard"},
		{"provided total zero is kept", map[string]string{"input": "0.01", "output": "0.02"}, Input{Usage: Usage{"input": 100, "output": 200, "total": 300}, Provided: map[string]float64{"total": 0}}, ptr(0), map[string]float64{"total": 0}, false, "standard"},
		{"provided input only sums to total", map[string]string{"input": "0.01", "output": "0.02"}, Input{Usage: Usage{"input": 100, "output": 200, "total": 300}, Provided: map[string]float64{"input": 2}}, ptr(2), map[string]float64{"input": 2, "total": 2}, false, "standard"},
		{"provided custom key leaves total unknown", map[string]string{"input": "0.01", "output": "0.02"}, Input{Usage: Usage{"input": 100, "output": 200, "total": 300}, Provided: map[string]float64{"custom": 2}}, nil, map[string]float64{"custom": 2}, true, "standard"},
		{"priced total is not added to components", map[string]string{"input": "0.01", "total": "0.03"}, Input{Usage: Usage{"input": 100, "output": 200, "total": 300}}, ptr(9), map[string]float64{"input": 1, "total": 9}, false, "standard"},
		{"empty usage stays unknown", map[string]string{"input": "0.01"}, Input{Usage: Usage{}}, nil, map[string]float64{}, true, ""},
		{"total only with no price stays unknown", map[string]string{"input": "0.01"}, Input{Usage: Usage{"total": 300}}, nil, map[string]float64{}, true, "standard"},
		{"known zero is preserved", map[string]string{"input": "0"}, Input{Usage: Usage{"input": 100, "output": 0, "total": 100}}, ptr(0), map[string]float64{"input": 0, "total": 0}, false, "standard"},
		{"ttl cache falls back to aggregate only when absent", map[string]string{"cache_creation_input_tokens": "0.00000375", "input_cache_creation_1h": "0.000006"}, Input{Usage: Usage{"input_cache_creation_5m": 2000, "input_cache_creation_1h": 10256}}, ptr(0.069036), map[string]float64{"input_cache_creation_5m": 0.0075, "input_cache_creation_1h": 0.061536, "total": 0.069036}, false, "standard"},
		{"prototype names are ordinary keys", map[string]string{"toString": "0.01"}, Input{Usage: Usage{"toString": 2, "__proto__": 3}}, ptr(0.02), map[string]float64{"toString": 0.02, "total": 0.02}, false, "standard"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := catalogWith(t, c.prices).Cost("m", c.in)
			if !eqTotal(r.Total, c.total) || r.Unpriced != c.unpriced || r.TierID != c.tierID {
				t.Fatalf("got total=%v unpriced=%v tier=%q", r.Total, r.Unpriced, r.TierID)
			}
			for k, v := range c.costs {
				if got, ok := r.Costs[k]; !ok || math.Abs(got-v) > 1e-9 {
					t.Errorf("cost %q = %v (present %v), want %v", k, got, ok, v)
				}
			}
			if len(r.Costs) != len(c.costs) {
				t.Errorf("costs %v, want %v", r.Costs, c.costs)
			}
		})
	}
}

func TestCostMatchesContextAndParsedAttributes(t *testing.T) {
	tier := Tier{ID: "priority-long", Name: "Priority long context", Priority: 1,
		Conditions: []Condition{
			{Source: "model_parameters", Key: "service_tier", Operator: "in", Values: []string{"priority"}},
			{Source: "metadata", Key: "enabled", Operator: "in", Values: []string{"true"}},
			{Pattern: "^input", Operator: "gt", Value: 100},
		},
		Prices: map[string]Price{"input": rat(t, "0.04")}}
	c := catalogWith(t, map[string]string{"input": "0.01", "output": "0.02"}, tier)
	r := c.Cost("m", Input{Usage: Usage{"input": 150.5}, ModelParameters: `{"service_tier":"priority"}`, Metadata: map[string]any{"enabled": true}})
	if r.TierID != "priority-long" || r.Total == nil || math.Abs(*r.Total-6.02) > 1e-9 {
		t.Fatalf("got %+v", r)
	}
	// Without the attributes the tier must not apply.
	r = c.Cost("m", Input{Usage: Usage{"input": 150.5}})
	if r.TierID != "standard" {
		t.Fatalf("tier %q without attributes", r.TierID)
	}
}

// TestUnknownModelIsUnpricedNeverZero is acceptance (d).
func TestUnknownModelIsUnpricedNeverZero(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	r := c.Cost("no-such-model-9", Input{Usage: Usage{"input": 1000, "output": 1000}})
	if !r.Unpriced || r.Total != nil || len(r.Costs) != 0 || r.Tier != "" {
		t.Fatalf("unknown model priced: %+v", r)
	}
}
