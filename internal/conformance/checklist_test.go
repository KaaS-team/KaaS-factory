package conformance

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// testNames returns every Test17_ function declared in this package's test files.
func testNames(t *testing.T) map[string]bool {
	t.Helper()
	files, err := filepath.Glob("*_test.go")
	if err != nil {
		t.Fatal(err)
	}
	out := map[string]bool{}
	for _, name := range files {
		f, err := parser.ParseFile(token.NewFileSet(), name, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, d := range f.Decls {
			if fn, ok := d.(*ast.FuncDecl); ok && fn.Recv == nil && strings.HasPrefix(fn.Name.Name, "Test17_") {
				out[fn.Name.Name] = true
			}
		}
	}
	return out
}

func Test17MappingEveryItemHasATestOrAReason(t *testing.T) {
	have := testNames(t)
	for _, it := range append(Rows17(), Items18()...) {
		switch {
		case it.Test != "" && it.NotApplicable != "":
			t.Errorf("%s %q: set Test or NotApplicable, not both", it.Ref, it.Text)
		case it.Test == "" && it.NotApplicable == "":
			t.Errorf("%s %q: no test and no reason", it.Ref, it.Text)
		case it.Test != "" && !have[it.Test]:
			t.Errorf("%s %q: maps to %s, which does not exist", it.Ref, it.Text, it.Test)
		}
		for _, n := range it.Also {
			if !have[n] {
				t.Errorf("%s %q: also maps to %s, which does not exist", it.Ref, it.Text, n)
			}
		}
	}
}

func Test17MappingEveryTestIsMapped(t *testing.T) {
	used := map[string]bool{}
	for _, it := range append(Rows17(), Items18()...) {
		used[it.Test] = true
		for _, n := range it.Also {
			used[n] = true
		}
	}
	for name := range testNames(t) {
		if !used[name] {
			t.Errorf("%s proves no spec line; add it to checklist.go", name)
		}
	}
}

// The counts are the spec's: a row dropped from the table shows up here.
func Test17MappingCountsMatchSpec(t *testing.T) {
	want := map[string]int{"17.1": 15, "17.2": 12, "17.3": 12, "17.4": 15, "17.5": 16, "17.6": 6, "17.7": 6, "17.8": 4, "18.1": 18}
	got := map[string]int{}
	for _, it := range append(Rows17(), Items18()...) {
		got[it.Ref]++
	}
	for ref, n := range want {
		if got[ref] != n {
			t.Errorf("section %s: table has %d lines, spec has %d", ref, got[ref], n)
		}
	}
	if len(got) != len(want) {
		t.Errorf("table covers sections %v, want %v", got, want)
	}
}
