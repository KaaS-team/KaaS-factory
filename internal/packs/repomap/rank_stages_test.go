package repomap

import (
	"context"
	"reflect"
	"testing"
)

func stageFixture(t *testing.T) (Options, map[string]bool) {
	root := fixture(t)
	return Options{Root: root, Chat: []string{"a.go"}, Others: allFiles, MentionedFiles: map[string]bool{"core.go": true}}, map[string]bool{"a.go": true}
}

func TestCandidatesSortedUnion(t *testing.T) {
	got := candidates(Options{Chat: []string{"z.go", "a.go"}, Others: []string{"m.go", "a.go"}})
	if want := []string{"a.go", "m.go", "z.go"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
}

func TestTagsStage(t *testing.T) {
	o, chat := stageFixture(t)
	ts, err := tags(context.Background(), o, candidates(o), chat)
	if err != nil {
		t.Fatal(err)
	}
	// Seeds: 5 files, so 20 each. a.go is chat, core.go is mentioned.
	if ts.pers["a.go"] != 20 || ts.pers["core.go"] != 20 || len(ts.pers) != 2 {
		t.Fatalf("pers = %v", ts.pers)
	}
	if !ts.defines["CoreEngine"]["core.go"] || len(ts.defs[[2]string{"core.go", "CoreEngine"}]) != 1 {
		t.Fatalf("defines = %v", ts.defines)
	}
	if !reflect.DeepEqual(ts.refs["CoreEngine"], []string{"a.go", "b.go", "c.go", "core.go"}) {
		t.Fatalf("refs = %v", ts.refs["CoreEngine"])
	}
}

func TestTagsStageCancelled(t *testing.T) {
	o, chat := stageFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := tags(ctx, o, candidates(o), chat); err == nil {
		t.Fatal("want the context error")
	}
}

func TestGraphStage(t *testing.T) {
	o, chat := stageFixture(t)
	ts, _ := tags(context.Background(), o, candidates(o), chat)
	edges := graph(ts, nil, chat)
	w := map[string]float64{}
	for _, e := range edges {
		if e.ident == "CoreEngine" {
			w[e.src+">"+e.dst] = e.w
		}
	}
	// CoreEngine is a camel-case name of 8 or more characters, so a plain edge weighs 10 and a chat referrer 50 times that.
	if w["a.go>core.go"] != 500 || w["b.go>core.go"] != 10 || w["c.go>core.go"] != 10 {
		t.Fatalf("CoreEngine edges = %v", w)
	}
}

func TestGraphStageUnreferencedGetsSelfLoop(t *testing.T) {
	ts := &tagSet{
		defines: map[string]map[string]bool{"Lonely": {"l.go": true}},
		refs:    map[string][]string{"Other": {"o.go"}},
	}
	got := graph(ts, nil, map[string]bool{})
	if want := []edge{{"l.go", "l.go", 0.1, "Lonely"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("edges = %v, want %v", got, want)
	}
}

func TestPagerankStageSumsToOne(t *testing.T) {
	edges := []edge{{"a", "b", 1, "x"}, {"b", "c", 1, "y"}}
	r := pagerank(edges, map[string]float64{"a": 1})
	var sum float64
	for _, v := range r {
		sum += v
	}
	if sum < 0.999 || sum > 1.001 {
		t.Fatalf("ranks = %v", r)
	}
	if r["b"] <= 0 || len(r) != 3 {
		t.Fatalf("ranks = %v", r)
	}
}

func TestRankOrderStage(t *testing.T) {
	o := Options{Others: []string{"x.go", "y.go", "z.go"}}
	ts := &tagSet{defs: map[[2]string][]Tag{
		{"x.go", "X"}: {{File: "x.go", Name: "X", Kind: "def"}},
		{"c.go", "C"}: {{File: "c.go", Name: "C", Kind: "def"}},
	}}
	edges := []edge{{"y.go", "x.go", 1, "X"}, {"y.go", "c.go", 3, "C"}}
	ranked := map[string]float64{"y.go": 0.5, "x.go": 0.3, "c.go": 0.2}
	got := rankOrder(o, ts, edges, ranked, map[string]bool{"c.go": true})
	// c.go is chat: skipped. x.go's definition, then y.go (ranked, no defs), then z.go (unranked).
	want := []Tag{{File: "x.go", Name: "X", Kind: "def"}, {File: "y.go"}, {File: "z.go"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v, want %+v", got, want)
	}
}
