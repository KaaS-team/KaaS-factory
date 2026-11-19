package repomap

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var update = flag.Bool("update", false, "rewrite testdata/*.golden")

func splitbillFiles(t *testing.T) []string {
	t.Helper()
	var files []string
	root := filepath.Join("testdata", "splitbill")
	err := filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(root, p)
			files = append(files, filepath.ToSlash(rel))
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

func renderTags(tags []Tag) string {
	var b strings.Builder
	for _, x := range tags {
		fmt.Fprintf(&b, "%s\t%s\t%s\t%d\n", x.File, x.Name, x.Kind, x.Line)
	}
	return b.String()
}

// TestRankGoldenSplitbill pins the whole ordered Rank output on the splitbill fixture, so a
// refactor of Rank cannot change it.
func TestRankGoldenSplitbill(t *testing.T) {
	root := filepath.Join("testdata", "splitbill")
	files := splitbillFiles(t)
	cases := map[string]Options{
		"plain":  {Root: root, Others: files},
		"chat":   {Root: root, Chat: []string{"src/index.ts"}, Others: files},
		"seeded": {Root: root, Others: files, MentionedIdents: map[string]bool{"splitCents": true}, MentionedFiles: map[string]bool{"src/bill/report.ts": true}},
	}
	for name, o := range cases {
		t.Run(name, func(t *testing.T) {
			r, err := Rank(context.Background(), o)
			if err != nil {
				t.Fatal(err)
			}
			got := renderTags(r)
			g := filepath.Join("testdata", "rank-"+name+".golden")
			if *update {
				if err := os.WriteFile(g, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(g)
			if err != nil {
				t.Fatal(err)
			}
			if got != string(want) {
				t.Fatalf("rank output changed\n--- got\n%s--- want\n%s", got, want)
			}
		})
	}
}
