package sampling

import "testing"

// The pinned values come from the upstream algorithm run once; a change to the
// domain string or bit handling makes them move.
func TestValueIsStableAcrossRuns(t *testing.T) {
	for _, id := range []string{"ticket-1", "ticket-2", ""} {
		a, b := Value(id), Value(id)
		if a != b || a < 0 || a >= 1 {
			t.Fatalf("Value(%q) = %v then %v, want equal and in [0,1)", id, a, b)
		}
	}
	if Value("ticket-1") == Value("ticket-2") {
		t.Fatal("different targets share a value")
	}
	if got, want := Value("ticket-1"), pinned["ticket-1"]; got != want {
		t.Fatalf("Value(ticket-1) = %v, want pinned %v", got, want)
	}
}

func TestSample(t *testing.T) {
	for _, c := range []struct {
		name        string
		value, rate float64
		want        bool
	}{
		{"rate one", 0.99, 1, true},
		{"rate above one", 0.99, 2, true},
		{"rate zero", 0, 0, false},
		{"rate negative", 0, -1, false},
		{"below rate", 0.2, 0.5, true},
		{"at rate", 0.5, 0.5, false},
		{"above rate", 0.7, 0.5, false},
	} {
		if got := Sample(c.value, c.rate); got != c.want {
			t.Errorf("%s: got %v, want %v", c.name, got, c.want)
		}
	}
}

func TestRatesPerRule(t *testing.T) {
	r := Rates{Default: 0, Rules: map[string]float64{"always": 1, "never": 0}}
	if !r.Should("always", "t") || r.Should("never", "t") {
		t.Fatal("rule rate not applied")
	}
	if r.Should("unlisted", "t") {
		t.Fatal("unlisted rule must use the default rate 0")
	}
	if !(Rates{Default: 1}).Should("unlisted", "t") {
		t.Fatal("default rate 1 must sample")
	}
}

func TestRatesRoughlyHonoured(t *testing.T) {
	r, n := Rates{Default: 0.25}, 0
	for i := 0; i < 4000; i++ {
		if r.Should("r", string(rune('a'+i%26))+string(rune(i))) {
			n++
		}
	}
	if n < 800 || n > 1200 {
		t.Fatalf("sampled %d of 4000 at rate 0.25", n)
	}
}

// pinned was computed with the upstream TypeScript algorithm (node crypto) and our domain string.
var pinned = map[string]float64{"ticket-1": 0.38214900860312184}
