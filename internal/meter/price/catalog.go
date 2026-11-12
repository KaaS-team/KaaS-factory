package price

import (
	_ "embed" // the catalog and overrides ship inside the binary
	"encoding/json"
	"fmt"
	"math/big"
	"regexp"
	"sort"
)

//go:embed catalog.json
var catalogJSON []byte

//go:embed overrides.json
var overridesJSON []byte

// Source says where the embedded catalog came from.
type Source struct {
	URL     string `json:"source"`
	SHA     string `json:"sha"`
	License string `json:"license"`
}

// Model is one priced model: a name, a pattern that recognises its aliases, and its tiers.
type Model struct {
	Name         string `json:"modelName"`
	MatchPattern string `json:"matchPattern"`
	Tiers        []Tier `json:"pricingTiers"`
	re           *regexp.Regexp
}

// Catalog finds models by name and prices usage against them.
type Catalog struct {
	Source Source
	models []Model
}

// UnmarshalJSON reads a price written as a JSON number, such as 2.5e-06, without rounding it.
func (p *Price) UnmarshalJSON(b []byte) error {
	r, ok := ratOf(string(b))
	if !ok {
		return fmt.Errorf("price: %q is not a number", b)
	}
	*p = r
	return nil
}

func ratOf(s string) (Price, bool) {
	r, ok := new(big.Rat).SetString(s)
	return Price{r}, ok
}

// New builds a catalog from models. A model in overrides replaces the one of the same name.
func New(models []Model, overrides ...Model) (*Catalog, error) {
	byName := map[string]Model{}
	for _, m := range append(append([]Model{}, models...), overrides...) {
		byName[m.Name] = m
	}
	c := &Catalog{}
	for _, m := range byName {
		re, err := regexp.Compile(m.MatchPattern)
		if err != nil {
			return nil, fmt.Errorf("price: model %s: %w", m.Name, err) // Go regexp has no lookaround
		}
		m.re = re
		c.models = append(c.models, m)
	}
	sort.Slice(c.models, func(i, j int) bool { return c.models[i].Name < c.models[j].Name })
	return c, nil
}

// Load returns the embedded catalog with the embedded manual overrides applied.
func Load() (*Catalog, error) {
	var file struct {
		Source
		Models []Model `json:"models"`
	}
	if err := json.Unmarshal(catalogJSON, &file); err != nil {
		return nil, fmt.Errorf("price: catalog.json: %w", err)
	}
	var over []Model
	if err := json.Unmarshal(overridesJSON, &over); err != nil {
		return nil, fmt.Errorf("price: overrides.json: %w", err)
	}
	c, err := New(file.Models, over...)
	if c != nil {
		c.Source = file.Source
	}
	return c, err
}

// Overrides returns the embedded manual overrides, which win over any upstream price.
func Overrides() ([]Model, error) {
	var over []Model
	err := json.Unmarshal(overridesJSON, &over)
	return over, err
}

func (c *Catalog) find(name string) *Model {
	for i := range c.models {
		if c.models[i].re.MatchString(name) {
			return &c.models[i]
		}
	}
	return nil
}

func sortedKeys(u Usage) []string {
	keys := make([]string, 0, len(u))
	for k := range u {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Models returns the catalog's models, overrides applied, ordered by name.
func (c *Catalog) Models() []Model { return c.models }
