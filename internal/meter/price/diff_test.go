package price

import (
	"strings"
	"testing"
)

func model(name, in string) Model {
	return Model{Name: name, MatchPattern: "^" + name + "$", Tiers: []Tier{{ID: "s", Name: "Standard", IsDefault: true, Prices: map[string]Price{"input": priceOf(in)}}}}
}

func priceOf(s string) Price { r, _ := ratOf(s); return r }

func TestDiff(t *testing.T) {
	ours := []Model{model("claude-same", "1e-6"), model("claude-moved", "1e-6"), model("claude-gone", "1e-6"), model("claude-pinned", "1e-6")}
	up := []Model{model("claude-same", "0.000001"), model("claude-moved", "2e-6"), model("claude-new", "1e-6"), model("claude-pinned", "9e-6"), model("llama-3", "1e-6"), model("claude-new-pinned", "5e-6")}
	over := []Model{model("claude-pinned", "1e-6"), model("claude-new-pinned", "1e-6")}
	d := Diff(ours, up, over)
	if got := strings.Join(d.Changed, ","); got != "claude-moved" {
		t.Errorf("changed = %q", got)
	}
	if got := strings.Join(d.Missing, ","); got != "claude-new" {
		t.Errorf("missing = %q (llama is filtered, claude-pinned is overridden)", got)
	}
	if got := strings.Join(d.Removed, ","); got != "claude-gone" {
		t.Errorf("removed = %q", got)
	}
	rep := d.Report("abc1234")
	for _, want := range []string{"abc1234", "claude-moved", "claude-new", "claude-gone"} {
		if !strings.Contains(rep, want) {
			t.Errorf("report lacks %q:\n%s", want, rep)
		}
	}
	if !Diff(ours, ours, nil).Empty() {
		t.Error("identical catalogs differ")
	}
}

func TestFilterKeepsOurModelsOnly(t *testing.T) {
	raw := `[{"modelName":"claude-x","matchPattern":"^x$","pricingTiers":[]},{"modelName":"gemini-2","matchPattern":"^g$","pricingTiers":[]},{"modelName":"gpt-4o-audio-preview","matchPattern":"^a$","pricingTiers":[]},{"modelName":"o3","matchPattern":"^o3$","pricingTiers":[]}]`
	ms, err := ParseUpstream([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, m := range ms {
		names = append(names, m.Name)
	}
	if got := strings.Join(names, ","); got != "claude-x,o3" {
		t.Fatalf("kept %q", got)
	}
}
