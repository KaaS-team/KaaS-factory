// Ported from Aider-AI/aider@5dc9490 aider/repomap.py
//
// Package repomap builds a ranked, token-budgeted symbol map of a repository. It is a Go port of the
// ranking (get_ranked_tags) and budget search (get_ranked_tags_map_uncached) in aider's repomap.py.
// The binary stays CGO_ENABLED=0, so tree-sitter is not used: Go files go through go/parser and
// ts, js and py files through regex tag queries.
package repomap

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"regexp"
	"strings"
)

// MaxFileBytes is the largest file ParseFile will read; bigger files are skipped.
const MaxFileBytes = 512 << 10

// ErrTooLarge is returned by ParseFile for a file over MaxFileBytes.
var ErrTooLarge = errors.New("repomap: file over size cap")

// Tag is one definition or reference of a name in a file. Text is the source line of a definition.
type Tag struct {
	File string `json:"file"`
	Name string `json:"name"`
	Kind string `json:"kind"` // "def" or "ref"
	Line int    `json:"line"`
	Text string `json:"text,omitempty"`
}

var (
	identRe = regexp.MustCompile(`[A-Za-z_$][A-Za-z0-9_$]*`)
	tsDefs  = []*regexp.Regexp{
		regexp.MustCompile(`^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)`),
		regexp.MustCompile(`^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>`),
		regexp.MustCompile(`^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$`),
	}
	pyDefs = []*regexp.Regexp{regexp.MustCompile(`^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)`)}
	// keywords the method pattern would otherwise take for a definition
	notDefs = map[string]bool{"if": true, "for": true, "while": true, "switch": true, "catch": true, "function": true, "return": true, "constructor": false}
)

// ParseFile returns the definition and reference tags of one file, chosen by extension. A file with
// an unknown extension has no tags. A file over MaxFileBytes returns ErrTooLarge and a cancelled ctx
// returns its error.
func ParseFile(ctx context.Context, rel string, src []byte) ([]Tag, error) {
	if len(src) > MaxFileBytes {
		return nil, ErrTooLarge
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	switch strings.ToLower(filepath.Ext(rel)) {
	case ".go":
		return parseGo(rel, src), nil
	case ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs":
		return parseRegex(ctx, rel, src, tsDefs)
	case ".py":
		return parseRegex(ctx, rel, src, pyDefs)
	}
	return nil, nil
}

func parseGo(rel string, src []byte) []Tag {
	fset := token.NewFileSet()
	f, _ := parser.ParseFile(fset, rel, src, parser.SkipObjectResolution) // a partial tree is still useful
	if f == nil {
		return nil
	}
	lines := strings.Split(string(src), "\n")
	var tags []Tag
	def := func(id *ast.Ident) {
		line := fset.Position(id.Pos()).Line
		tags = append(tags, Tag{File: rel, Name: id.Name, Kind: "def", Line: line, Text: lines[line-1]})
	}
	for _, d := range f.Decls {
		switch d := d.(type) {
		case *ast.FuncDecl:
			def(d.Name)
		case *ast.GenDecl:
			for _, s := range d.Specs {
				switch s := s.(type) {
				case *ast.TypeSpec:
					def(s.Name)
				case *ast.ValueSpec:
					for _, n := range s.Names {
						def(n)
					}
				}
			}
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok {
			tags = append(tags, Tag{File: rel, Name: id.Name, Kind: "ref", Line: fset.Position(id.Pos()).Line})
		}
		return true
	})
	return tags
}

// parseRegex is the regex tag query: aider falls back to plain identifier tokens for references too.
func parseRegex(ctx context.Context, rel string, src []byte, defs []*regexp.Regexp) ([]Tag, error) {
	var tags []Tag
	for i, line := range strings.Split(string(src), "\n") {
		if i%256 == 0 {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
		}
		for _, re := range defs {
			if m := re.FindStringSubmatch(line); m != nil && !notDefs[m[1]] {
				tags = append(tags, Tag{File: rel, Name: m[1], Kind: "def", Line: i + 1, Text: line})
				break
			}
		}
		for _, w := range identRe.FindAllString(line, -1) {
			tags = append(tags, Tag{File: rel, Name: w, Kind: "ref", Line: i + 1})
		}
	}
	return tags, nil
}
