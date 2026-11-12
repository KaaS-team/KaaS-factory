package docgen_test

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
)

var (
	headingRe = regexp.MustCompile(`(?m)^## (factory[^\n]*)$`)
	spanRe    = regexp.MustCompile("`factory( [^`]*)?`")
)

// commandPaths reads the command tree from docs/cli-reference.md, which cmd/factory's
// TestCLIReferenceFresh keeps equal to newRoot()'s tree.
func commandPaths(t *testing.T, root string) map[string]bool {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(root, "docs", "cli-reference.md"))
	if err != nil {
		t.Fatal(err)
	}
	set := map[string]bool{}
	for _, m := range headingRe.FindAllStringSubmatch(string(b), -1) {
		set[m[1]] = true
	}
	return set
}

// namedCommand returns the longest prefix of a `factory ...` span that is a real command path,
// and the first word after it that looks like a command name (lowercase, not a flag or placeholder).
func namedCommand(span string, tree map[string]bool) (found string, bad string) {
	words := strings.Fields(strings.Trim(span, "`"))
	cur := "factory"
	for _, w := range words[1:] {
		if !regexp.MustCompile(`^[a-z][a-z-]*$`).MatchString(w) {
			break
		}
		if tree[cur+" "+w] {
			cur += " " + w
			continue
		}
		if len(strings.Fields(cur)) == 1 || tree[cur] && hasChildren(cur, tree) {
			return cur, cur + " " + w
		}
		break
	}
	return cur, ""
}

func hasChildren(p string, tree map[string]bool) bool {
	for k := range tree {
		if strings.HasPrefix(k, p+" ") {
			return true
		}
	}
	return false
}

// TestDocsNameOnlyRealCommands fails when README.md or a doc under docs/ names a `factory <cmd>`
// that the command tree does not have.
func TestDocsNameOnlyRealCommands(t *testing.T) {
	root := filepath.Join("..", "..")
	tree := commandPaths(t, root)
	files := []string{filepath.Join(root, "README.md")}
	more, _ := filepath.Glob(filepath.Join(root, "docs", "*.md"))
	files = append(files, more...)
	sub, _ := filepath.Glob(filepath.Join(root, "docs", "*", "*.md"))
	files = append(files, sub...)
	var bad []string
	for _, f := range files {
		if strings.HasSuffix(f, "cli-reference.md") {
			continue
		}
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range spanRe.FindAllString(string(b), -1) {
			if _, b2 := namedCommand(m, tree); b2 != "" {
				bad = append(bad, f+": "+m)
			}
		}
	}
	sort.Strings(bad)
	if len(bad) > 0 {
		t.Fatalf("docs name commands the tree lacks:\n%s", strings.Join(bad, "\n"))
	}
}

// TestNamedCommandBranches pins the extractor's rules.
func TestNamedCommandBranches(t *testing.T) {
	tree := map[string]bool{"factory": true, "factory run": true, "factory config": true, "factory config get": true}
	for _, c := range []struct{ span, bad string }{
		{"`factory run`", ""},
		{"`factory run --x`", ""},
		{"`factory config get <key>`", ""},
		{"`factory watch`", "factory watch"},
		{"`factory config nope`", "factory config nope"},
		{"`factory`", ""},
		{"`factory <cmd>`", ""},
	} {
		if _, bad := namedCommand(c.span, tree); bad != c.bad {
			t.Errorf("%s: bad=%q want %q", c.span, bad, c.bad)
		}
	}
}
