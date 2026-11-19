// Command doccheck fails when a backticked path in README.md or AGENTS.md does not exist.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var span = regexp.MustCompile("`([^`\n]+)`")

// Missing returns each backticked path in doc that does not exist under root. A span is a path when it
// has no space or glob characters and ends in "/", or has a "/" and a file extension, or is a bare
// .md, .sh, .json or .yml name.
func Missing(root, doc string) ([]string, error) {
	b, err := os.ReadFile(filepath.Join(root, doc))
	if err != nil {
		return nil, err
	}
	var out []string
	for _, m := range span.FindAllStringSubmatch(string(b), -1) {
		p, ext := m[1], filepath.Ext(m[1])
		if strings.ContainsAny(p, " *<>{}$:=") || strings.HasPrefix(p, "-") {
			continue
		}
		isDir := strings.HasSuffix(p, "/")
		isFile := ext != "" && (strings.Contains(p, "/") || strings.Contains(".md.sh.json.yml", ext))
		if !isDir && !isFile {
			continue
		}
		if _, err := os.Stat(filepath.Join(root, p)); err != nil {
			out = append(out, p)
		}
	}
	return out, nil
}

func main() {
	code := 0
	for _, doc := range []string{"README.md", "AGENTS.md"} {
		got, err := Missing(".", doc)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		for _, p := range got {
			fmt.Fprintf(os.Stderr, "%s names a path that does not exist: %s\n", doc, p)
			code = 1
		}
	}
	os.Exit(code)
}
