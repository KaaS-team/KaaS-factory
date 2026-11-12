package repomap

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func names(tags []Tag, kind string) []string {
	var out []string
	for _, t := range tags {
		if t.Kind == kind {
			out = append(out, t.Name)
		}
	}
	return out
}

func has(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// TestParseDefinitions covers acceptance (a): go, ts and py definitions and references.
func TestParseDefinitions(t *testing.T) {
	cases := []struct {
		file, src string
		defs      []string
		refs      []string
	}{
		{"a.go", "package a\n\ntype Server struct{}\n\nfunc (s *Server) Start() { helper() }\n\nfunc helper() {}\n\nconst Max = 1\n",
			[]string{"Server", "Start", "helper", "Max"}, []string{"helper"}},
		{"a.ts", "export class Cache {\n  get(k: string) {}\n}\nexport interface Opts {}\nexport type Id = string\nexport function load() { return new Cache() }\nexport const run = async (x) => load()\n",
			[]string{"Cache", "Opts", "Id", "load", "run"}, []string{"Cache", "load"}},
		{"a.py", "class Repo:\n    def clone(self):\n        return helper()\n\ndef helper():\n    pass\n",
			[]string{"Repo", "clone", "helper"}, []string{"helper"}},
	}
	for _, c := range cases {
		tags, err := ParseFile(context.Background(), c.file, []byte(c.src))
		if err != nil {
			t.Fatalf("%s: %v", c.file, err)
		}
		for _, d := range c.defs {
			if !has(names(tags, "def"), d) {
				t.Errorf("%s: missing def %s in %v", c.file, d, names(tags, "def"))
			}
		}
		for _, r := range c.refs {
			if !has(names(tags, "ref"), r) {
				t.Errorf("%s: missing ref %s", c.file, r)
			}
		}
	}
}

func TestParseUnknownExtensionHasNoTags(t *testing.T) {
	tags, err := ParseFile(context.Background(), "a.md", []byte("# hi\n"))
	if err != nil || len(tags) != 0 {
		t.Fatalf("got %v %v", tags, err)
	}
}

func TestParseBrokenGoIsNotFatal(t *testing.T) {
	if _, err := ParseFile(context.Background(), "a.go", []byte("package a\nfunc (")); err != nil {
		t.Fatal(err)
	}
}

// TestParseCaps covers acceptance (e): size and time caps.
func TestParseCaps(t *testing.T) {
	big := strings.Repeat("x", MaxFileBytes+1)
	if _, err := ParseFile(context.Background(), "a.py", []byte("def "+big)); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("want ErrTooLarge, got %v", err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := ParseFile(ctx, "a.py", []byte("def f():\n  pass\n")); err == nil {
		t.Fatal("want context error")
	}
}

func write(t *testing.T, root, rel, body string) {
	t.Helper()
	p := filepath.Join(root, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func fixture(t *testing.T) string {
	root := t.TempDir()
	write(t, root, "core.go", "package p\n\nfunc CoreEngine() {}\n\nfunc rare() {}\n")
	write(t, root, "a.go", "package p\n\nfunc A() { CoreEngine() }\n")
	write(t, root, "b.go", "package p\n\nfunc B() { CoreEngine() }\n")
	write(t, root, "c.go", "package p\n\nfunc C() { CoreEngine(); RareThing() }\n")
	write(t, root, "other.go", "package p\n\nfunc RareThing() {}\n")
	return root
}

var allFiles = []string{"a.go", "b.go", "c.go", "core.go", "other.go"}

// TestRankPrefersReferenced covers acceptance (b): the most referenced definition ranks first.
func TestRankPrefersReferenced(t *testing.T) {
	root := fixture(t)
	r, err := Rank(context.Background(), Options{Root: root, Others: allFiles})
	if err != nil {
		t.Fatal(err)
	}
	if r[0].File != "core.go" || r[0].Name != "CoreEngine" {
		t.Fatalf("first = %+v", r[0])
	}
}

// TestRankSeeds covers acceptance (b): ticket-mentioned idents and files seed the ranking.
func TestRankSeeds(t *testing.T) {
	tie := t.TempDir()
	write(t, tie, "x.go", "package p\n\nfunc Xfn() {}\n")
	write(t, tie, "y.go", "package p\n\nfunc Yfn() {}\n")
	write(t, tie, "u.go", "package p\n\nfunc U() { Xfn(); Yfn() }\n")
	tied := []string{"u.go", "x.go", "y.go"}
	base, _ := Rank(context.Background(), Options{Root: tie, Others: tied})
	r, _ := Rank(context.Background(), Options{Root: tie, Others: tied, MentionedIdents: map[string]bool{"Xfn": true}})
	if base[0].Name != "Yfn" || r[0].Name != "Xfn" {
		t.Fatalf("ident seed: base first %s, seeded first %s", base[0].Name, r[0].Name)
	}
	sym := t.TempDir()
	write(t, sym, "p.go", "package p\n\nfunc P() { Pfn() }\n")
	write(t, sym, "q.go", "package p\n\nfunc Pfn() {}\n")
	write(t, sym, "r.go", "package p\n\nfunc R() { Rfn() }\n")
	write(t, sym, "s.go", "package p\n\nfunc Rfn() {}\n")
	four := []string{"p.go", "q.go", "r.go", "s.go"}
	base, _ = Rank(context.Background(), Options{Root: sym, Others: four})
	r, _ = Rank(context.Background(), Options{Root: sym, Others: four, MentionedFiles: map[string]bool{"p.go": true}})
	if base[0].Name != "Rfn" || r[0].Name != "Pfn" {
		t.Fatalf("file seed: base first %s, seeded first %s", base[0].Name, r[0].Name)
	}
}

// TestRankSkipsChatFiles keeps files already in the chat out of the map (repomap.py get_ranked_tags).
func TestRankSkipsChatFiles(t *testing.T) {
	root := fixture(t)
	r, _ := Rank(context.Background(), Options{Root: root, Chat: []string{"core.go"}, Others: allFiles})
	for _, x := range r {
		if x.File == "core.go" {
			t.Fatalf("chat file ranked: %+v", x)
		}
	}
}

func TestIdentWeight(t *testing.T) {
	cases := []struct {
		name      string
		ident     string
		mentioned bool
		definers  int
		want      float64
	}{
		{"plain", "foo", false, 1, 1},
		{"mentioned", "foo", true, 1, 10},
		{"snake long", "load_config", false, 1, 10},
		{"camel long", "LoadConfig", false, 1, 10},
		{"camel short", "AbCd", false, 1, 1},
		{"private", "_foo", false, 1, 0.1},
		{"many definers", "foo", false, 6, 0.1},
		{"mentioned long private", "_load_config", true, 1, 10 * 10 * 0.1},
	}
	for _, c := range cases {
		if got := identWeight(c.ident, c.mentioned, c.definers); got != c.want {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

// TestBudget covers acceptance (c): the map fits the budget and grows with it.
func TestBudget(t *testing.T) {
	root := t.TempDir()
	var files []string
	for i := 0; i < 40; i++ {
		f := "f" + string(rune('a'+i%26)) + string(rune('a'+i/26)) + ".go"
		write(t, root, f, "package p\n\nfunc Fn"+f[1:3]+"Long() { Fn"+f[1:3]+"Long() }\n")
		files = append(files, f)
	}
	var prev int
	for _, budget := range []int{60, 200, 400, 100000} {
		out, err := Build(context.Background(), Options{Root: root, Others: files, Budget: budget})
		if err != nil {
			t.Fatal(err)
		}
		n := EstimateTokens(out)
		if n > budget {
			t.Errorf("budget %d: map has %d tokens", budget, n)
		}
		if budget >= 200 && n == 0 {
			t.Errorf("budget %d: empty map", budget)
		}
		if n < prev {
			t.Errorf("budget %d: map shrank to %d from %d", budget, n, prev)
		}
		prev = n
	}
	if !strings.Contains(mustBuild(t, root, files, 100000), "FnaaLong") {
		t.Error("large budget should list every definition")
	}
}

func mustBuild(t *testing.T, root string, files []string, budget int) string {
	out, err := Build(context.Background(), Options{Root: root, Others: files, Budget: budget})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestBudgetUsesInjectedMeter(t *testing.T) {
	root := fixture(t)
	calls := 0
	_, _ = Build(context.Background(), Options{Root: root, Others: allFiles, Budget: 50, Tokens: func(s string) int { calls++; return len(s) }})
	if calls == 0 {
		t.Fatal("injected estimator was not used")
	}
}

// TestCacheKeyedByMtime covers acceptance (d).
func TestCacheKeyedByMtime(t *testing.T) {
	root := fixture(t)
	c := NewCache()
	opts := Options{Root: root, Others: allFiles, Cache: c}
	if _, err := Rank(context.Background(), opts); err != nil {
		t.Fatal(err)
	}
	if c.Misses != len(allFiles) || c.Hits != 0 {
		t.Fatalf("first run: %d misses %d hits", c.Misses, c.Hits)
	}
	_, _ = Rank(context.Background(), opts)
	if c.Hits != len(allFiles) {
		t.Fatalf("second run hits = %d", c.Hits)
	}
	p := filepath.Join(root, "a.go")
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(p, later, later); err != nil {
		t.Fatal(err)
	}
	before := c.Misses
	_, _ = Rank(context.Background(), opts)
	if c.Misses != before+1 {
		t.Fatalf("touched file should miss once, misses %d -> %d", before, c.Misses)
	}
}

func TestCacheSaveLoad(t *testing.T) {
	root := fixture(t)
	c := NewCache()
	_, _ = Rank(context.Background(), Options{Root: root, Others: allFiles, Cache: c})
	p := filepath.Join(t.TempDir(), "tags.json")
	if err := c.Save(p); err != nil {
		t.Fatal(err)
	}
	c2, err := LoadCache(p)
	if err != nil {
		t.Fatal(err)
	}
	_, _ = Rank(context.Background(), Options{Root: root, Others: allFiles, Cache: c2})
	if c2.Hits != len(allFiles) {
		t.Fatalf("loaded cache hits = %d", c2.Hits)
	}
	if c3, err := LoadCache(filepath.Join(t.TempDir(), "none.json")); err != nil || c3 == nil {
		t.Fatalf("missing cache file should be empty: %v", err)
	}
}

func TestMentions(t *testing.T) {
	files, idents := Mentions("Fix CoreEngine in `a.go` and internal/x/y.go please", []string{"a.go", "internal/x/y.go", "z.go"})
	if !files["a.go"] || !files["internal/x/y.go"] || files["z.go"] {
		t.Fatalf("files %v", files)
	}
	if !idents["CoreEngine"] {
		t.Fatalf("idents %v", idents)
	}
}

func TestCommandPrintsMap(t *testing.T) {
	root := fixture(t)
	cmd := NewCommand()
	var out strings.Builder
	cmd.SetOut(&out)
	cmd.SetArgs([]string{"--root", root, "--budget", "500", "--ticket", "fix CoreEngine"})
	if err := cmd.Execute(); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "func CoreEngine()") {
		t.Fatalf("map:\n%s", out.String())
	}
	if _, err := os.Stat(filepath.Join(root, ".factory", "cache", "repomap.json")); err != nil {
		t.Fatalf("cache not written: %v", err)
	}
}

// flipCtx reports no error for its first calls to Err, then context.Canceled, so the cancel lands mid-parse.
type flipCtx struct {
	context.Context
	left int
}

func (c *flipCtx) Err() error {
	if c.left--; c.left < 0 {
		return context.Canceled
	}
	return nil
}

func TestParseStopsMidFile(t *testing.T) {
	src := strings.Repeat("x = 1\n", 2000)
	if _, err := ParseFile(&flipCtx{Context: context.Background(), left: 1}, "a.py", []byte(src)); err == nil {
		t.Fatal("parse ignored a cancel that arrived after it started")
	}
}
