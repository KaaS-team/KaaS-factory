package price

import (
	"regexp"
	"testing"
)

// TestEmbeddedCatalog covers acceptance (a) and (e): the filtered catalog loads, carries its
// source, holds only Anthropic and OpenAI models, and includes the Claude 5 family.
func TestEmbeddedCatalog(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Source.SHA != "2e6d0343daf51b767ce232fe7305777d32aa8ac8" || c.Source.License == "" || c.Source.URL == "" {
		t.Fatalf("source not recorded: %+v", c.Source)
	}
	ours := regexp.MustCompile(`^(claude|gpt|o[0-9]|chatgpt)`)
	for _, m := range c.models {
		if !ours.MatchString(m.Name) {
			t.Errorf("%s is neither Anthropic nor OpenAI", m.Name)
		}
		def := false
		for _, tr := range m.Tiers {
			def = def || tr.IsDefault
		}
		if !def {
			t.Errorf("%s has no default tier", m.Name)
		}
	}
	for _, n := range []string{"claude-fable-5-2", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "gpt-5.2"} {
		if r := c.Cost(n, Input{Usage: Usage{"input": 1000, "output": 1000}}); r.Unpriced {
			t.Errorf("%s is unpriced", n)
		}
	}
}

func TestCostByCloudAlias(t *testing.T) {
	c, _ := Load()
	in := Input{Usage: Usage{"input": 1000}}
	a, b := c.Cost("claude-opus-5-5", in), c.Cost("us.anthropic.claude-opus-5-5-v1:0", in)
	if a.Unpriced || b.Unpriced || *a.Total != *b.Total {
		t.Fatalf("alias differs: %+v vs %+v", a, b)
	}
}

func TestFastModeTier(t *testing.T) {
	c, _ := Load()
	std := c.Cost("claude-opus-5-5", Input{Usage: Usage{"input": 1000}})
	fast := c.Cost("claude-opus-5-5", Input{Usage: Usage{"input": 1000}, ModelParameters: map[string]any{"speed": "fast"}})
	if fast.Tier != "Fast mode" || std.Tier != "Standard" || *fast.Total <= *std.Total {
		t.Fatalf("std=%+v fast=%+v", std, fast)
	}
}

func TestOverrideWins(t *testing.T) {
	base := Model{Name: "m", MatchPattern: "^m$", Tiers: []Tier{{ID: "s", Name: "Standard", IsDefault: true, Prices: map[string]Price{"input": rat(t, "1")}}}}
	over := base
	over.Tiers = []Tier{{ID: "s", Name: "Standard", IsDefault: true, Prices: map[string]Price{"input": rat(t, "3")}}}
	c, err := New([]Model{base}, over)
	if err != nil {
		t.Fatal(err)
	}
	if r := c.Cost("m", Input{Usage: Usage{"input": 2}}); *r.Total != 6 {
		t.Fatalf("override ignored: %+v", r)
	}
}

func TestBadPatternIsAnError(t *testing.T) {
	if _, err := New([]Model{{Name: "x", MatchPattern: "(?<=a)b"}}); err == nil {
		t.Fatal("lookbehind compiled in Go regexp")
	}
}
