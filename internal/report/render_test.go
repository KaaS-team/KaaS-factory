package report

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite golden files")

func built(t *testing.T) Report {
	t.Helper()
	r, err := Build(context.Background(), &fakeSource{recs: fixture()}, win)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func golden(t *testing.T, name string, got []byte) {
	t.Helper()
	p := filepath.Join("testdata", name)
	if *update {
		if err := os.WriteFile(p, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(p)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("%s differs\n--- got\n%s\n--- want\n%s", name, got, want)
	}
}

// Golden for --by team over the two-team fixture. The numbers were computed by hand:
// alpha merged A,B: 2600 tokens, 1300 per PR, rework 1/2, touches 3/2, cycle (10h+4h)/2 = 7h;
// beta merged C: 1400 tokens, touches 1, cycle 6h; D never merged adds 1000 unmerged tokens.
func TestGoldenByTeam(t *testing.T) {
	r := built(t)
	var md, js bytes.Buffer
	if err := WriteMarkdown(&md, r, ByTeam); err != nil {
		t.Fatal(err)
	}
	if err := WriteJSON(&js, r, ByTeam); err != nil {
		t.Fatal(err)
	}
	golden(t, "by_team.golden.md", md.Bytes())
	golden(t, "by_team.golden.json", js.Bytes())
}

// TestJSONAndMarkdownAgree computes both outputs and compares every number.
func TestJSONAndMarkdownAgree(t *testing.T) {
	r := built(t)
	for _, by := range []GroupBy{ByTeam, ByWorkflow, ByPack} {
		var md, js bytes.Buffer
		if err := WriteMarkdown(&md, r, by); err != nil {
			t.Fatal(err)
		}
		if err := WriteJSON(&js, r, by); err != nil {
			t.Fatal(err)
		}
		var doc struct {
			Total View   `json:"total"`
			Rows  []View `json:"rows"`
		}
		if err := json.Unmarshal(js.Bytes(), &doc); err != nil {
			t.Fatal(err)
		}
		lines := map[string][]string{}
		for _, l := range strings.Split(md.String(), "\n") {
			if strings.HasPrefix(l, "| ") {
				cells := strings.Split(strings.Trim(l, "| "), " | ")
				lines[cells[0]] = cells
			}
		}
		for _, v := range append([]View{doc.Total}, doc.Rows...) {
			cells, ok := lines[v.Key]
			if !ok {
				t.Fatalf("%s: no markdown row for %q", by, v.Key)
			}
			want := []string{v.Key, strconv.Itoa(v.MergedPRs), num(v.TokensPerMergedPR), num(v.ReworkRate),
				num(v.HumanTouchesPerPR), num(v.MeanCycleSeconds), strconv.FormatInt(v.MergedTokens, 10),
				strconv.FormatInt(v.UnmergedTokens, 10), num(v.CostUSD)}
			if strings.Join(cells, "|") != strings.Join(want, "|") {
				t.Fatalf("%s %s: markdown %v, json %v", by, v.Key, cells, want)
			}
		}
	}
}

func TestWriteUnknownGroup(t *testing.T) {
	if err := WriteMarkdown(&bytes.Buffer{}, Report{}, GroupBy("x")); err == nil {
		t.Fatal("want error")
	}
	if err := WriteJSON(&bytes.Buffer{}, Report{}, GroupBy("x")); err == nil {
		t.Fatal("want error")
	}
}
