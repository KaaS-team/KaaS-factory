// Package provenance keeps THIRD_PARTY_NOTICES.md in step with the
// "// Ported from <repo>@<sha> <path>" headers on copied Go files.
package provenance

import (
	"bufio"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	headerRe = regexp.MustCompile(`^// Ported from ([\w.-]+/[\w.-]+)@([0-9a-f]{7,40}) (\S+)`)
	noticeRe = regexp.MustCompile(`(?m)^## ([\w.-]+/[\w.-]+)@([0-9a-f]{7,40})\s*$`)
)

// skipDirs are never walked: dependencies, build output and the frozen TS tree.
var skipDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, "dist": true, ".factory": true}

// Header is one ported-file header.
type Header struct {
	File, Repo, SHA, Path string
}

// Check returns one problem per Go file whose header names a repo@sha that
// the notices file does not list.
func Check(root string) ([]string, error) {
	notices, err := os.ReadFile(filepath.Join(root, "THIRD_PARTY_NOTICES.md"))
	if err != nil {
		return nil, err
	}
	listed := map[string]bool{}
	for _, m := range noticeRe.FindAllStringSubmatch(string(notices), -1) {
		listed[m[1]+"@"+m[2]] = true
	}
	hs, err := Headers(root)
	if err != nil {
		return nil, err
	}
	var problems []string
	for _, h := range hs {
		if !listed[h.Repo+"@"+h.SHA] {
			problems = append(problems, h.File+": ported from "+h.Repo+"@"+h.SHA+" but THIRD_PARTY_NOTICES.md has no \"## "+h.Repo+"@"+h.SHA+"\" section")
		}
	}
	return problems, nil
}

// Headers finds every ported-file header in the first 10 lines of each .go file.
func Headers(root string) ([]Header, error) {
	var out []Header
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if skipDirs[d.Name()] && p != root {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(p, ".go") {
			return nil
		}
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		defer func() { _ = f.Close() }()
		sc := bufio.NewScanner(f)
		for i := 0; i < 10 && sc.Scan(); i++ {
			if m := headerRe.FindStringSubmatch(sc.Text()); m != nil {
				rel, _ := filepath.Rel(root, p)
				out = append(out, Header{File: rel, Repo: m[1], SHA: m[2], Path: m[3]})
				break
			}
		}
		return sc.Err()
	})
	return out, err
}
