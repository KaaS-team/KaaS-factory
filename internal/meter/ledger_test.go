package meter

import (
	"encoding/json"
	"os"
	"testing"
)

func fixture(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile("testdata/spend_comments.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Bodies map[string]string `json:"bodies"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	return f.Bodies
}

// The comment bodies in testdata were written by the TypeScript GitHubSpend.
func TestLedgerRoundTripsTheTypeScriptComments(t *testing.T) {
	bodies := fixture(t)
	if len(bodies) != 4 {
		t.Fatalf("fixture has %d bodies", len(bodies))
	}
	for key, body := range bodies {
		got, err := DecodeSpend(body)
		if err != nil || len(got) != 1 {
			t.Fatalf("%s: %v %v", key, got, err)
		}
		if enc := EncodeSpend(got[0]); enc != body {
			t.Errorf("%s: re-encoded\n%q\nwant\n%q", key, enc, body)
		}
	}
	got, _ := DecodeSpend(bodies["7:100"])
	if got[0] != (Spend{Holder: "worker-1", CostUSD: 0.30000000000000004, UnreportedRuns: 1, Runs: 3}) {
		t.Errorf("decoded %+v", got[0])
	}
	day, _ := DecodeSpend(bodies["1:101"])
	if day[0].Day != "2026-11-12" {
		t.Errorf("day = %q", day[0].Day)
	}
}

func TestDecodeSpendDropsForgeriesAndJunk(t *testing.T) {
	rows := []struct {
		name string
		body string
		n    int
	}{
		{"no marker", "hello", 0},
		{"negative cost", `<!-- factory:spend {"holder":"x","costUsd":-100,"unreportedRuns":0,"runs":1} -->`, 0},
		{"negative runs", `<!-- factory:spend {"holder":"x","costUsd":1,"unreportedRuns":0,"runs":-1} -->`, 0},
		{"string cost", `<!-- factory:spend {"holder":"x","costUsd":"1","unreportedRuns":0,"runs":1} -->`, 0},
		{"missing holder", `<!-- factory:spend {"costUsd":1,"unreportedRuns":0,"runs":1} -->`, 0},
		{"not json", `<!-- factory:spend {nope} -->`, 0},
		{"missing field", `<!-- factory:spend {"holder":"x","costUsd":0.54,"model":"x"} -->`, 0},
		{"two markers", `a <!-- factory:spend {"holder":"x","costUsd":1,"unreportedRuns":0,"runs":1} --> b <!-- factory:spend {"holder":"y","costUsd":2,"unreportedRuns":1,"runs":2} -->`, 2},
	}
	for _, r := range rows {
		got, err := DecodeSpend(r.body)
		if err != nil {
			t.Errorf("%s: %v", r.name, err)
		}
		if len(got) != r.n {
			t.Errorf("%s: %d tallies, want %d", r.name, len(got), r.n)
		}
	}
}

func TestEncodeSpendNumbersMatchJavaScript(t *testing.T) {
	rows := map[float64]string{0: "0", 1: "1", 0.1: "0.1", 1e21: "1e+21", 1e-7: "1e-7", 123456.789: "123456.789", 0.000001: "0.000001"}
	for f, want := range rows {
		if got := jsNumber(f); got != want {
			t.Errorf("jsNumber(%v) = %s, want %s", f, got, want)
		}
	}
}
