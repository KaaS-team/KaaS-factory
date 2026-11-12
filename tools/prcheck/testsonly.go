// Ported from scripts/check-tests-only.ts at ts-final
package main

import (
	"fmt"
	"io"
	"regexp"
	"strings"
)

// kinds are the ways a change can weaken the tests.
var kinds = []string{"only-tests", "deleted-test", "removed-assertion", "new-skip", "loose-matcher"}

// Finding is one weakening: its kind, the file and a detail line.
type Finding struct {
	Kind, File, Detail string
}

// DiffFile is one file of a unified=0 diff.
type DiffFile struct {
	Path           string
	Deleted        bool
	Added, Removed []string
}

var (
	assertion = regexp.MustCompile(`\b(?:expect|assert)\s*\(|\bassert\.\w+\s*\(`)
	testDecl  = regexp.MustCompile("\\b(?:test|it)(?:\\.\\w+)?\\s*\\(\\s*[\"'`]")
	skip      = regexp.MustCompile(`\b(?:test|it|describe)\.(?:skip|todo|skipIf)\b|@quarantine`)
	loose     = regexp.MustCompile(`\.(?:toBeTruthy|toBeFalsy|toBeDefined|toBeUndefined)\(\)|expect\.anything\(\)`)
	reasonRe  = regexp.MustCompile(`(?m)^Test change reason:[ \t]*(\S.{9,})$`)
	diffHead  = regexp.MustCompile(`^diff --git a/(.+) b/(.+)$`)

	testPath = regexp.MustCompile(`(?:^|/)tests?/|\.(?:test|spec)\.(?:ts|tsx|js|jsx|mts|cts|mjs|cjs)$|_test\.(?:go|py)$|(?:^|/)test_[^/]*\.py$`)
	// Fixtures, the old mutation list and the per-entry mutation files sit under tests/ but are data, not tests.
	testData = regexp.MustCompile(`(?:^|/)fixtures/|(?:^|/)tests/mutations\.json$|(?:^|/)tests/mutations/`)
)

func isTestFile(path string) bool { return testPath.MatchString(path) && !testData.MatchString(path) }

func parseDiff(text string) []DiffFile {
	var files []DiffFile
	cur := -1
	aPath := ""
	for _, line := range strings.Split(text, "\n") {
		switch {
		case strings.HasPrefix(line, "diff --git "):
			m := diffHead.FindStringSubmatch(line)
			f := DiffFile{}
			aPath = ""
			if m != nil {
				aPath, f.Path = m[1], m[2]
			}
			files = append(files, f)
			cur = len(files) - 1
		case cur < 0:
		case strings.HasPrefix(line, "deleted file mode"):
			files[cur].Deleted = true
			files[cur].Path = aPath
		case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
		case strings.HasPrefix(line, "+"):
			files[cur].Added = append(files[cur].Added, line[1:])
		case strings.HasPrefix(line, "-"):
			files[cur].Removed = append(files[cur].Removed, line[1:])
		}
	}
	return files
}

func count(lines []string, re *regexp.Regexp) int {
	n := 0
	for _, l := range lines {
		if re.MatchString(l) {
			n++
		}
	}
	return n
}

func findings(files []DiffFile) []Finding {
	var out []Finding
	allTests := len(files) > 0
	for _, f := range files {
		allTests = allTests && isTestFile(f.Path)
	}
	if allTests {
		out = append(out, Finding{"only-tests", "", "every changed file is a test"})
	}
	for _, f := range files {
		if !isTestFile(f.Path) {
			continue
		}
		decls := count(f.Removed, testDecl) - count(f.Added, testDecl)
		if f.Deleted || decls > 0 {
			detail := "the file is deleted"
			if !f.Deleted {
				detail = fmt.Sprintf("%d fewer test declarations", decls)
			}
			out = append(out, Finding{"deleted-test", f.Path, detail})
		}
		if asserts := count(f.Removed, assertion) - count(f.Added, assertion); asserts > 0 {
			first := ""
			for _, l := range f.Removed {
				if assertion.MatchString(l) {
					first = strings.TrimSpace(l)
					break
				}
			}
			out = append(out, Finding{"removed-assertion", f.Path, fmt.Sprintf("%d fewer assertions, first removed: %s", asserts, first)})
		}
		for _, l := range f.Added {
			if skip.MatchString(l) {
				out = append(out, Finding{"new-skip", f.Path, strings.TrimSpace(l)})
			}
		}
		for _, l := range f.Added {
			if loose.MatchString(l) {
				out = append(out, Finding{"loose-matcher", f.Path, strings.TrimSpace(l)})
			}
		}
	}
	return out
}

func (f Finding) String() string { return f.Kind + ": " + f.File + ": " + f.Detail }

// diffProblems is empty when the diff weakens nothing or the body states a reason.
func diffProblems(diff, body string) []string {
	found := findings(parseDiff(diff))
	if len(found) == 0 || reasonRe.MatchString(body) {
		return nil
	}
	var out []string
	for _, f := range found {
		out = append(out, f.String())
	}
	return append(out, `state why in a "Test change reason:" line in the PR body`)
}

func runTestsOnly(dir string, args []string, getenv func(string) string, stdout, stderr io.Writer) int {
	if len(args) < 2 || args[0] == "" || args[1] == "" {
		sayln(stderr, "usage: prcheck tests-only <base> <head>")
		return 2
	}
	base, head := args[0], args[1]
	out, err := gitOut(dir, "diff", "--unified=0", "--no-color", base+"..."+head)
	if err != nil {
		sayf(stderr, "git diff %s...%s: %v\n", base, head, err)
		return 2
	}
	if found := diffProblems(string(out), getenv("PR_BODY")); len(found) > 0 {
		sayf(stderr, "check-tests-only:\n- %s\n", strings.Join(found, "\n- "))
		return 1
	}
	all := findings(parseDiff(string(out)))
	if len(all) == 0 {
		sayln(stdout, "check-tests-only: ok")
		return 0
	}
	lines := make([]string, len(all))
	for i, f := range all {
		lines[i] = f.String()
	}
	sayf(stdout, "check-tests-only: reason given:\n- %s\n", strings.Join(lines, "\n- "))
	return 0
}
