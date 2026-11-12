// Ported from langfuse/langfuse@2e6d034 packages/shared/src/server/pricing-tiers/calculateModelUsageCosts.ts

package price

import (
	"encoding/json"
	"fmt"
	"maps"
	"math/big"
)

// Input is what Cost prices: usage, any cost the provider already reported, and the request
// parameters and metadata that tier conditions can test. ModelParameters and Metadata may be a
// map or a JSON object string; only string, number and bool values are used.
type Input struct {
	Usage           Usage
	Provided        map[string]float64
	ModelParameters any
	Metadata        any
}

// Result is the priced usage. Total is nil, and Unpriced true, whenever no total could be
// derived: an unknown model, empty usage, or no price for any usage type. It is never a zero guess.
type Result struct {
	Costs    map[string]float64
	Total    *float64
	Tier     string
	TierID   string
	Unpriced bool
}

// A model may carry only an aggregate cache-write price.
var (
	ttlCacheTypes       = []string{"input_cache_creation_5m", "input_cache_creation_1h"}
	aggregateCacheTypes = []string{"cache_creation_input_tokens", "input_cache_creation"}
)

// Cost prices usage for model. A cost supplied in Provided replaces catalog inference.
func (c *Catalog) Cost(model string, in Input) Result {
	m := c.find(model)
	if m == nil {
		return Result{Costs: map[string]float64{}, Unpriced: true}
	}
	var tier *Tier
	if len(in.Usage) > 0 { // empty usage never selects a tier
		tier = matchTier(m.Tiers, in.Usage, attrsFor(m.Tiers, in))
	}
	costs, total := provided(in.Provided)
	if costs == nil {
		costs, total = inferred(in.Usage, tier)
	}
	if _, has := costs["total"]; !has && total != nil {
		costs["total"] = *total
	}
	r := Result{Costs: costs, Total: total, Unpriced: total == nil}
	if tier != nil {
		r.Tier, r.TierID = tier.Name, tier.ID
	}
	return r
}

func provided(p map[string]float64) (map[string]float64, *float64) {
	if len(p) == 0 {
		return nil, nil
	}
	costs := maps.Clone(p)
	if t, ok := p["total"]; ok {
		return costs, &t
	}
	for k := range p {
		if k != "input" && k != "output" {
			return costs, nil
		}
	}
	t := p["input"] + p["output"]
	return costs, &t
}

func inferred(u Usage, tier *Tier) (map[string]float64, *float64) {
	costs := map[string]float64{}
	var sum float64
	for _, k := range sortedKeys(u) {
		p, ok := lookup(tier, k)
		if !ok {
			continue
		}
		f, _ := new(big.Rat).Mul(p.r, new(big.Rat).SetFloat64(u[k])).Float64()
		costs[k] = f
		sum += f
	}
	if t, ok := costs["total"]; ok {
		return costs, &t
	}
	if len(costs) == 0 {
		return costs, nil
	}
	return costs, &sum
}

func lookup(t *Tier, usageType string) (Price, bool) {
	if t == nil {
		return Price{}, false
	}
	if p, ok := t.Prices[usageType]; ok {
		return p, true
	}
	for _, ttl := range ttlCacheTypes {
		if usageType == ttl {
			for _, agg := range aggregateCacheTypes {
				if p, ok := t.Prices[agg]; ok {
					return p, true
				}
			}
		}
	}
	return Price{}, false
}

// attrsFor reads only the sources some tier condition tests, as the upstream does.
func attrsFor(tiers []Tier, in Input) matchAttrs {
	var a matchAttrs
	for _, t := range tiers {
		for _, c := range t.Conditions {
			switch {
			case t.IsDefault || c.Source == "":
			case c.Source == "model_parameters":
				a.params = stringMap(in.ModelParameters)
			default:
				a.meta = stringMap(in.Metadata)
			}
		}
	}
	return a
}

func stringMap(v any) map[string]string {
	if s, ok := v.(string); ok {
		var parsed any
		if json.Unmarshal([]byte(s), &parsed) != nil {
			return nil
		}
		v = parsed
	}
	out := map[string]string{}
	switch m := v.(type) {
	case map[string]string:
		return m
	case map[string]any:
		for k, x := range m {
			switch x.(type) {
			case string, bool, float64, float32, int, int64:
				out[k] = fmt.Sprint(x)
			}
		}
	}
	return out
}
