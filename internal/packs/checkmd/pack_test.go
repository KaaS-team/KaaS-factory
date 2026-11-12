package checkmd

import (
	"slices"
	"strings"
	"testing"
)

func TestParse(t *testing.T) {
	for _, tc := range []struct {
		name, src, wantErr string
		want               Pack
	}{
		{"scalar and list", "---\nname: A\ndescription: d\nglobs: \"*.go\"\nregex: [x, y]\n---\nbody\n",
			"", Pack{Name: "A", Description: "d", Globs: []string{"*.go"}, Regex: []string{"x", "y"}, Body: "body\n"}},
		{"no front matter", "just text", "front matter", Pack{}},
		{"unterminated", "---\nname: A\n", "front matter", Pack{}},
		{"missing name", "---\ndescription: d\n---\nb", "name", Pack{}},
		{"bad regex", "---\nname: A\nregex: \"(\"\n---\nb", "regex", Pack{}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Parse("", []byte(tc.src))
			if tc.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), tc.wantErr) {
					t.Fatalf("err = %v, want %q", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got.Name != tc.want.Name || got.Description != tc.want.Description || got.Body != tc.want.Body ||
				!slices.Equal(got.Globs, tc.want.Globs) || !slices.Equal(got.Regex, tc.want.Regex) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
}

func TestApplies(t *testing.T) {
	files := map[string]string{"a/x.go": "func Foo() {}", "docs/r.md": "hello"}
	for _, tc := range []struct {
		name  string
		scope string
		globs []string
		regex []string
		files map[string]string
		want  bool
	}{
		{"no globs no regex applies", "", nil, nil, files, true},
		{"no files at all", "", nil, nil, nil, false},
		{"glob hit", "", []string{"**/*.go"}, nil, files, true},
		{"glob miss", "", []string{"**/*.rs"}, nil, files, false},
		{"negated only, other file survives", "", []string{"!**/*.go"}, nil, files, true},
		{"negated only, all excluded", "", []string{"!**/*.go"}, nil, map[string]string{"a/x.go": ""}, false},
		{"positive plus negated excludes", "", []string{"**/*.go", "!a/**"}, nil, files, false},
		{"positive plus negated other", "", []string{"**/*.go", "!docs/**"}, nil, files, true},
		{"regex hit", "", []string{"**/*.go"}, []string{`func\s+Foo`}, files, true},
		{"regex miss", "", []string{"**/*.go"}, []string{`func\s+Bar`}, files, false},
		{"regex any pattern", "", nil, []string{"nope", "hello"}, files, true},
		{"regex only on glob-matching files", "", []string{"docs/**"}, []string{"Foo"}, files, false},
		{"colocated in dir", "a", nil, nil, files, true},
		{"colocated outside dir", "b", nil, nil, files, false},
		{"colocated is not a name prefix", "a/x", nil, nil, files, false},
		{"colocated with glob miss", "docs", []string{"**/*.go"}, nil, files, false},
		{"colocated dotslash", "./a/", nil, nil, files, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p := Pack{Name: "p", Dir: tc.scope, Globs: tc.globs, Regex: tc.regex}
			if err := p.compile(); err != nil {
				t.Fatal(err)
			}
			var paths []string
			for k := range tc.files {
				paths = append(paths, k)
			}
			if got := p.Applies(paths, tc.files); got != tc.want {
				t.Fatalf("Applies = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestSelectDropsPacksThatMissTheDiff(t *testing.T) {
	hit := Pack{Name: "go", Globs: []string{"**/*.go"}}
	miss := Pack{Name: "rs", Globs: []string{"**/*.rs"}}
	_ = hit.compile()
	_ = miss.compile()
	got := Select([]Pack{hit, miss}, []string{"a/x.go"}, nil)
	if len(got) != 1 || got[0].Name != "go" {
		t.Fatalf("Select = %+v", got)
	}
}
