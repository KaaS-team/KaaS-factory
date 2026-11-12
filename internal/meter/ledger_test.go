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
	if g := got[0]; g.Holder != "worker-1" || g.CostUSD != 0.30000000000000004 || g.UnreportedRuns != 1 || g.Runs != 3 || g.Attempts != nil {
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

// A stored v1 comment from before per-attempt rows: it decodes with no attempts and re-encodes
// byte for byte. The marker carries no version string, so rows ride in one optional field.
func TestLedgerOldV1CommentHasNoAttempts(t *testing.T) {
	old := "Factory usage record (operator data, hidden).\n" +
		`<!-- factory:spend {"holder":"worker-1","costUsd":0.54,"unreportedRuns":0,"runs":2} -->`
	got, err := DecodeSpend(old)
	if err != nil || len(got) != 1 {
		t.Fatalf("%v %v", got, err)
	}
	if len(got[0].Attempts) != 0 {
		t.Fatalf("attempts = %+v", got[0].Attempts)
	}
	if enc := EncodeSpend(got[0]); enc != old {
		t.Fatalf("re-encoded %q", enc)
	}
}

func TestLedgerAttemptRowsRoundTrip(t *testing.T) {
	in := Spend{Holder: "worker-1", CostUSD: 1.5, Runs: 2, Attempts: []AttemptTokens{
		{N: 1, Input: 1000, Output: 500, CacheRead: 20, CacheWrite: 7},
		{N: 2, Input: 400, Output: 100},
	}}
	body := EncodeSpend(in)
	want := "Factory usage record (operator data, hidden).\n" +
		`<!-- factory:spend {"holder":"worker-1","costUsd":1.5,"unreportedRuns":0,"runs":2,` +
		`"attempts":[{"n":1,"in":1000,"out":500,"cacheRead":20,"cacheWrite":7},{"n":2,"in":400,"out":100,"cacheRead":0,"cacheWrite":0}]} -->`
	if body != want {
		t.Fatalf("body\n%q\nwant\n%q", body, want)
	}
	got, _ := DecodeSpend(body)
	if len(got) != 1 || len(got[0].Attempts) != 2 || got[0].Attempts[0] != in.Attempts[0] || got[0].Attempts[1] != in.Attempts[1] {
		t.Fatalf("decoded %+v", got)
	}
}

func TestDecodeSpendDropsBadAttemptRowsOnly(t *testing.T) {
	body := `<!-- factory:spend {"holder":"x","costUsd":1,"unreportedRuns":0,"runs":2,"attempts":[` +
		`{"n":1,"in":5,"out":6,"cacheRead":0,"cacheWrite":0},{"n":0,"in":1,"out":1,"cacheRead":0,"cacheWrite":0},` +
		`{"n":2,"in":-1,"out":1,"cacheRead":0,"cacheWrite":0},{"n":3,"in":"x"}]} -->`
	got, _ := DecodeSpend(body)
	if len(got) != 1 || len(got[0].Attempts) != 1 || got[0].Attempts[0].N != 1 {
		t.Fatalf("decoded %+v", got)
	}
}
