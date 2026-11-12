package github_test

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	gh "github.com/KaaS-team/factory/internal/tracker/github"
)

// loadGolden reads comment bodies the TS runner's withDataMarker produced (src/engine/common.ts).
func loadGolden(t *testing.T) map[string]string {
	t.Helper()
	raw, err := os.ReadFile("testdata/markers.golden.json")
	if err != nil {
		t.Fatal(err)
	}
	m := map[string]string{}
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func TestMarkerGoldenRoundTrip(t *testing.T) {
	golden := loadGolden(t)
	if len(golden) < 8 {
		t.Fatalf("golden table has %d rows, want at least 8", len(golden))
	}
	for name, body := range golden {
		t.Run(name, func(t *testing.T) {
			ms := gh.ParseData(body)
			if len(ms) != 1 {
				t.Fatalf("decoded %d markers, want 1", len(ms))
			}
			got := gh.EncodeData(gh.StripData(body), ms[0].Stage, ms[0].JSON)
			if got != body {
				t.Fatalf("re-encoded bytes differ\n got: %q\nwant: %q", got, body)
			}
		})
	}
}

func TestParseDataSkipsForgeries(t *testing.T) {
	cases := []struct {
		name string
		body string
		want int
	}{
		{"no marker", "hello", 0},
		{"not json", `<!-- factory:data {oops} -->`, 0},
		{"stage missing", `<!-- factory:data {"json":{}} -->`, 0},
		{"stage not a string", `<!-- factory:data {"stage":3,"json":{}} -->`, 0},
		{"two markers in one body", `<!-- factory:data {"stage":"a","json":1} --> and <!-- factory:data {"stage":"b","json":2} -->`, 2},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := gh.ParseData(tc.body); len(got) != tc.want {
				t.Fatalf("got %d markers, want %d", len(got), tc.want)
			}
		})
	}
}

func TestStripDataOnlyTrailingMarker(t *testing.T) {
	body := "text\n\n<!-- factory:data {\"stage\":\"plan\",\"json\":{}} -->"
	if got := gh.StripData(body); got != "text" {
		t.Fatalf("StripData = %q", got)
	}
	mid := "a <!-- factory:data {\"stage\":\"plan\"} --> b"
	if got := gh.StripData(mid); got != mid {
		t.Fatalf("a marker that is not last must stay, got %q", got)
	}
}

func TestLatestAndCount(t *testing.T) {
	ms := gh.ParseData(
		gh.EncodeData("x", "verify", json.RawMessage(`{"result":"reject"}`)),
		gh.EncodeData("y", "plan", json.RawMessage(`{"n":1}`)),
		gh.EncodeData("z", "verify", json.RawMessage(`{"result":"pass"}`)),
	)
	got, ok := gh.Latest(ms, "verify")
	if !ok || string(got) != `{"result":"pass"}` {
		t.Fatalf("Latest = %s, %v", got, ok)
	}
	if _, ok := gh.Latest(ms, "build"); ok {
		t.Fatal("Latest found a stage that is absent")
	}
	if gh.Count(ms, "verify") != 2 {
		t.Fatal("Count(verify) != 2")
	}
}

func TestFindStatusPicksLatest(t *testing.T) {
	cs := []gh.Comment{
		{ID: 1, Body: "<!-- factory:status v1 -->\nround 1"},
		{ID: 2, Body: "chatter"},
		{ID: 3, Body: "<!-- factory:status v1 -->\nround 2"},
		{ID: 4, Body: "more chatter"},
	}
	c, ok := gh.FindStatus(cs)
	if !ok || c.ID != 3 {
		t.Fatalf("FindStatus = %+v, %v", c, ok)
	}
	if _, ok := gh.FindStatus(cs[:2][1:]); ok {
		t.Fatal("found a status comment in a thread without one")
	}
	if !strings.HasPrefix(gh.StatusMarker, "<!-- factory:status v1") {
		t.Fatal("StatusMarker drifted from the TS marker")
	}
}

// JSON.stringify leaves < > & and U+2028 alone; Go's default encoder would escape them.
func TestEncodeDataQuotesLikeJSONStringify(t *testing.T) {
	got := gh.EncodeData("b", "a<b>&c d", json.RawMessage("{ \"k\": \"<&>\" }"))
	want := "b\n\n<!-- factory:data {\"stage\":\"a<b>&c d\",\"json\":{\"k\":\"<&>\"}} -->"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}
