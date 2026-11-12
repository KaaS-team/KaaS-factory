package marker_test

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/marker"
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

// stripTrailing removes the marker that ends body, with the blank lines before it.
func stripTrailing(body string) string {
	return strings.TrimRight(regexp.MustCompile(`(?s)\n*<!-- factory:data \{.*?\} -->\s*$`).ReplaceAllString(body, ""), " \t\r\n")
}

func TestMarkerGoldenRoundTrip(t *testing.T) {
	golden := loadGolden(t)
	if len(golden) < 8 {
		t.Fatalf("golden table has %d rows, want at least 8", len(golden))
	}
	for name, body := range golden {
		t.Run(name, func(t *testing.T) {
			ms := marker.ParseData(body)
			if len(ms) != 1 {
				t.Fatalf("decoded %d markers, want 1", len(ms))
			}
			got := marker.EncodeData(stripTrailing(body), ms[0].Stage, ms[0].JSON)
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
			if got := marker.ParseData(tc.body); len(got) != tc.want {
				t.Fatalf("got %d markers, want %d", len(got), tc.want)
			}
		})
	}
}

func TestLatest(t *testing.T) {
	ms := marker.ParseData(
		marker.EncodeData("x", "verify", json.RawMessage(`{"result":"reject"}`)),
		marker.EncodeData("y", "plan", json.RawMessage(`{"n":1}`)),
		marker.EncodeData("z", "verify", json.RawMessage(`{"result":"pass"}`)),
	)
	got, ok := marker.Latest(ms, "verify")
	if !ok || string(got) != `{"result":"pass"}` {
		t.Fatalf("Latest = %s, %v", got, ok)
	}
	if _, ok := marker.Latest(ms, "build"); ok {
		t.Fatal("Latest found a stage that is absent")
	}
}

func TestStatusPrefixMatchesTS(t *testing.T) {
	if marker.Status != "<!-- factory:status v1" {
		t.Fatal("Status drifted from the TS marker")
	}
}

// JSON.stringify leaves < > & and U+2028 alone; Go's default encoder would escape them.
func TestEncodeDataQuotesLikeJSONStringify(t *testing.T) {
	got := marker.EncodeData("b", "a<b>&c d", json.RawMessage("{ \"k\": \"<&>\" }"))
	want := "b\n\n<!-- factory:data {\"stage\":\"a<b>&c d\",\"json\":{\"k\":\"<&>\"}} -->"
	if got != want {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWrapFindRoundTrip(t *testing.T) {
	for _, name := range []string{"queued", "spend"} {
		body := "x\n" + marker.Wrap(name, `{"a":1}`) + "\n" + marker.Wrap("other", `{"b":2}`) + marker.Wrap(name, `{"a":3}`)
		got := marker.Find(body, name)
		if len(got) != 2 || got[0] != `{"a":1}` || got[1] != `{"a":3}` {
			t.Fatalf("%s: Find = %q", name, got)
		}
	}
	if got := marker.Wrap("queued", `{"pr":7}`); got != `<!-- factory:queued {"pr":7} -->` {
		t.Fatalf("Wrap = %q", got)
	}
}

func TestAllowedOnlyByAllow(t *testing.T) {
	ctx := context.Background()
	if marker.Allowed(ctx) || !marker.Allowed(marker.Allow(ctx)) {
		t.Fatal("Allowed must be false on a plain context and true after Allow")
	}
}

func TestPositionRoundTripsAndSkipsOtherVersions(t *testing.T) {
	p := marker.Position{Node: "build", Base: 2, Fails: 1, PR: 7, Input: `say "hi" <!-- x -->`}
	body := marker.EncodePosition("Factory position: build.", p)
	got, ok := marker.LatestPosition("noise", body)
	p.V = marker.PositionV
	if !ok || got != p {
		t.Fatalf("LatestPosition = %+v, %v, want %+v", got, ok, p)
	}
	later := marker.EncodeData("x", marker.StagePosition, json.RawMessage(`{"v":99,"node":"future"}`))
	if got, ok := marker.LatestPosition(body, later); !ok || got.Node != "build" {
		t.Fatalf("a newer version was read: %+v, %v", got, ok)
	}
	if _, ok := marker.LatestPosition(marker.EncodeData("x", marker.StagePosition, json.RawMessage(`{"v":1}`))); ok {
		t.Fatal("a position without a node was accepted")
	}
}
