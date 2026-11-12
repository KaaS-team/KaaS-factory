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
	// fileRe matches a notice bullet: "- `path` from ...".
	fileRe = regexp.MustCompile("^- `([^`]+)` from ")
)

// skipDirs are never walked: dependencies, build output and the frozen TS tree.
var skipDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, "dist": true, ".factory": true}

// Header is one ported-file header.
type Header struct {
	File, Repo, SHA, Path string
}

// Check returns one problem per Go file whose header names a repo@sha that
// the notices file does not list, and one per file a notice section names that
// is missing or (for Go files) lacks a matching header.
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
	return append(problems, checkNoticeFiles(root, string(notices))...), nil
}

// checkNoticeFiles is the reverse direction: each "- `path` from" bullet under
// a "## repo@sha" section must name a file that exists and, when it is Go,
// carries a "Ported from" header for that same repo@sha.
func checkNoticeFiles(root, notices string) []string {
	var problems []string
	section := ""
	for _, line := range strings.Split(notices, "\n") {
		if strings.HasPrefix(line, "## ") {
			section = ""
			if m := noticeRe.FindStringSubmatch(line); m != nil {
				section = m[1] + "@" + m[2]
			}
			continue
		}
		m := fileRe.FindStringSubmatch(line)
		if m == nil || section == "" {
			continue
		}
		file := m[1]
		full := filepath.Join(root, filepath.FromSlash(file))
		if _, err := os.Stat(full); err != nil {
			problems = append(problems, file+": THIRD_PARTY_NOTICES.md lists it under "+section+" but the file does not exist")
			continue
		}
		if !strings.HasSuffix(file, ".go") {
			continue
		}
		if h, ok := headerOf(full); !ok || h.Repo+"@"+h.SHA != section {
			problems = append(problems, file+": THIRD_PARTY_NOTICES.md lists it under "+section+" but the file has no matching \"Ported from "+section+"\" header")
		}
	}
	return problems
}

// headerOf reads the ported-file header from the first 10 lines of one file.
func headerOf(path string) (Header, bool) {
	f, err := os.Open(path)
	if err != nil {
		return Header{}, false
	}
	defer func() { _ = f.Close() }()
	sc := bufio.NewScanner(f)
	for i := 0; i < 10 && sc.Scan(); i++ {
		if m := headerRe.FindStringSubmatch(sc.Text()); m != nil {
			return Header{File: path, Repo: m[1], SHA: m[2], Path: m[3]}, true
		}
	}
	return Header{}, false
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
