package plan

import (
	"os"
	"path/filepath"
	"testing"
)

func TestBodyRoundTripsTSFixtures(t *testing.T) {
	files, err := filepath.Glob("testdata/*.md")
	if err != nil || len(files) < 3 {
		t.Fatalf("fixtures: %v %v", files, err)
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		b, err := ParseBody(string(raw))
		if err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		if got := b.Render(); got != string(raw) {
			t.Errorf("%s: re-render differs\n got: %q\nwant: %q", f, got, raw)
		}
	}
}

func TestBodyViews(t *testing.T) {
	raw, _ := os.ReadFile("testdata/planned-issue.md")
	b, err := ParseBody(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	if got := b.Files(); len(got) != 3 || got[2] != "tests/resume.test.ts" {
		t.Errorf("files = %v", got)
	}
	if got := b.Acceptance(); len(got) != 2 || got[0] != "AC-1" {
		t.Errorf("acceptance = %v", got)
	}
}

func TestParseBodyMarker(t *testing.T) {
	if _, err := ParseBody("## Why\nx\n"); err == nil {
		t.Fatal("want error without marker")
	}
	if _, err := ParseBody("\n  " + Marker + "\n"); err != nil {
		t.Fatalf("leading whitespace allowed: %v", err)
	}
}

func TestBodyDeps(t *testing.T) {
	cases := []struct {
		name, body string
		want       []string
	}{
		{"none", Marker + "\nDeps: none\n## Why\nx\n", nil},
		{"list", Marker + "\nDeps: #7, t2 t3\n## Why\nx\n", []string{"#7", "t2", "t3"}},
		{"after sections ignored", Marker + "\n## Why\nDeps: a\n", nil},
	}
	for _, c := range cases {
		b, err := ParseBody(c.body)
		if err != nil {
			t.Fatal(err)
		}
		got := b.Deps()
		if len(got) != len(c.want) {
			t.Fatalf("%s: %v want %v", c.name, got, c.want)
		}
		for i := range got {
			if got[i] != c.want[i] {
				t.Errorf("%s: %v want %v", c.name, got, c.want)
			}
		}
	}
}
