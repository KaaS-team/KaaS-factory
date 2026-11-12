// Ported from scripts/check-tests-only.ts at ts-final
package main

import (
	"bytes"
	"reflect"
	"slices"
	"strings"
	"testing"
)

const reason = "Test change reason: renamed a helper, no assertion lost"

const srcAdd = "diff --git a/src/a.ts b/src/a.ts\nindex 1111111..2222222 100644\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+export const b = 2;\n"
const testHead = "diff --git a/tests/a.test.ts b/tests/a.test.ts\nindex 1111111..2222222 100644\n--- a/tests/a.test.ts\n+++ b/tests/a.test.ts\n"

// fixtures mirror tests/fixtures/tests-only/*.diff, one per kind plus clean.
var fixtures = map[string]string{
	"clean.diff": srcAdd + testHead + "@@ -6,0 +7 @@ describe(\"a\", () => {\n+    expect(b).toBe(2);\n",
	"deleted-test.diff": srcAdd + testHead + "@@ -5,3 +4,0 @@ describe(\"a\", () => {\n" +
		"-  test(\"old case\", () => {\n-    const x = 1;\n-  });\n",
	"loose-matcher.diff":     srcAdd + testHead + "@@ -6 +6 @@ describe(\"a\", () => {\n-    expect(a()).toBe(1);\n+    expect(a()).toBeTruthy();\n",
	"new-skip.diff":          srcAdd + testHead + "@@ -5 +5 @@ describe(\"a\", () => {\n-  test(\"case\", () => {\n+  test.skip(\"case\", () => {\n",
	"only-tests.diff":        testHead + "@@ -3,0 +4,3 @@ describe(\"a\", () => {\n+  test(\"adds one\", () => {\n+    expect(1 + 1).toBe(2);\n+  });\n",
	"removed-assertion.diff": srcAdd + testHead + "@@ -6 +5,0 @@ describe(\"a\", () => {\n-    expect(a()).toBe(1);\n",
}

func kindsOf(diff string) []string {
	var out []string
	for _, f := range findings(parseDiff(diff)) {
		out = append(out, f.Kind)
	}
	return out
}

func TestEveryKindHasAFixtureThatYieldsIt(t *testing.T) {
	for _, kind := range kinds {
		if !slices.Contains(kindsOf(fixtures[kind+".diff"]), kind) {
			t.Errorf("fixture %s.diff yields %v, want it to contain %s", kind, kindsOf(fixtures[kind+".diff"]), kind)
		}
	}
}

func TestEveryFixtureButCleanFailsWithoutAReasonAndPassesWithOne(t *testing.T) {
	n := 0
	for name, diff := range fixtures {
		if name == "clean.diff" {
			continue
		}
		n++
		if got := diffProblems(diff, ""); len(got) <= 1 {
			t.Errorf("%s without a reason: %q, want more than one line", name, got)
		}
		if got := diffProblems(diff, reason); len(got) != 0 {
			t.Errorf("%s with a reason: %q, want none", name, got)
		}
	}
	if n != len(kinds) {
		t.Fatalf("%d fixtures, want %d", n, len(kinds))
	}
}

func TestAFixtureTripsOnlyItsOwnKind(t *testing.T) {
	for _, kind := range kinds {
		if kind == "only-tests" {
			continue
		}
		set := slices.Compact(kindsOf(fixtures[kind+".diff"]))
		if !reflect.DeepEqual(set, []string{kind}) {
			t.Errorf("%s.diff trips %v", kind, set)
		}
	}
}

func TestCleanYieldsNothing(t *testing.T) {
	if got := findings(parseDiff(fixtures["clean.diff"])); len(got) != 0 {
		t.Fatalf("findings %v", got)
	}
	if got := diffProblems(fixtures["clean.diff"], ""); len(got) != 0 {
		t.Fatalf("problems %v", got)
	}
}

func TestARewrittenAssertionIsNotARemoval(t *testing.T) {
	diff := strings.Join([]string{
		"diff --git a/src/a.ts b/src/a.ts", "--- a/src/a.ts", "+++ b/src/a.ts", "@@ -1 +1 @@", "-x", "+y",
		"diff --git a/tests/a.test.ts b/tests/a.test.ts", "--- a/tests/a.test.ts", "+++ b/tests/a.test.ts",
		"@@ -1 +1 @@", "-  expect(a()).toBe(1);", "+  expect(a()).toBe(2);",
	}, "\n")
	if got := findings(parseDiff(diff)); len(got) != 0 {
		t.Fatalf("findings %v", got)
	}
}

func TestAReasonShorterThanTenCharactersIsRefused(t *testing.T) {
	if got := diffProblems(fixtures["new-skip.diff"], "Test change reason: short"); len(got) == 0 {
		t.Error("a 5 character reason was accepted")
	}
	if got := diffProblems(fixtures["new-skip.diff"], "Test change reason: ten chars!"); len(got) != 0 {
		t.Errorf("a 10 character reason was refused: %q", got)
	}
	if got := diffProblems(fixtures["new-skip.diff"], "intro\nTest change reason: ten chars!\nmore"); len(got) != 0 {
		t.Errorf("a reason on its own line was refused: %q", got)
	}
	if got := diffProblems(fixtures["new-skip.diff"], "see Test change reason: ten chars!"); len(got) == 0 {
		t.Error("a reason not at the start of a line was accepted")
	}
}

func TestADeletedTestFileTakesItsPathFromTheASide(t *testing.T) {
	diff := strings.Join([]string{
		"diff --git a/tests/gone.test.ts b/tests/b-side.test.ts", "deleted file mode 100644",
		"--- a/tests/gone.test.ts", "+++ /dev/null", "@@ -1 +0,0 @@", "-x",
	}, "\n")
	want := []DiffFile{{Path: "tests/gone.test.ts", Deleted: true, Removed: []string{"x"}}}
	if got := parseDiff(diff); !reflect.DeepEqual(got, want) {
		t.Fatalf("parseDiff = %+v, want %+v", got, want)
	}
	if !slices.Contains(kindsOf(diff), "deleted-test") {
		t.Fatalf("kinds %v", kindsOf(diff))
	}
}

func TestIsTestFile(t *testing.T) {
	for _, p := range []string{"tests/a.ts", "test/a.ts", "x/tests/y.json", "a.test.ts", "a.spec.tsx", "a.test.mjs", "a_test.go", "a_test.py", "pkg/test_a.py"} {
		if !isTestFile(p) {
			t.Errorf("isTestFile(%q) = false", p)
		}
	}
	for _, p := range []string{"src/a.ts", "scripts/latest.ts", "a.test.md", "src/contest.py", "tests/fixtures/x/a.diff", "tests/mutations.json", "tests/mutations/a.json"} {
		if isTestFile(p) {
			t.Errorf("isTestFile(%q) = true", p)
		}
	}
}

func TestProblemLines(t *testing.T) {
	got := diffProblems(fixtures["loose-matcher.diff"], "")
	want := []string{
		"loose-matcher: tests/a.test.ts: expect(a()).toBeTruthy();",
		`state why in a "Test change reason:" line in the PR body`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	got = diffProblems(fixtures["removed-assertion.diff"], "")
	if !strings.HasPrefix(got[0], "removed-assertion: tests/a.test.ts: 1 fewer assertions, first removed: expect(a()).toBe(1);") {
		t.Fatalf("got %q", got)
	}
	got = diffProblems(fixtures["deleted-test.diff"], "")
	if got[0] != "deleted-test: tests/a.test.ts: 1 fewer test declarations" {
		t.Fatalf("got %q", got)
	}
}

// testsOnlyRepo has src/a.ts and tests/a.test.ts on main, and a branch "work" to edit.
func testsOnlyRepo(t *testing.T) string {
	t.Helper()
	dir := gitRepo(t)
	commit(t, dir, "src/a.ts", "export const a = 1;\n", "src", "Dev <dev@x.io>")
	commit(t, dir, "tests/a.test.ts", "test(\"case\", () => {\n  expect(a()).toBe(1);\n});\n", "tests", "Dev <dev@x.io>")
	git(t, dir, nil, "checkout", "-q", "-b", "work")
	return dir
}

func runTestsOnlyCmd(dir, body string, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := run(dir, append([]string{"tests-only"}, args...), func(k string) string {
		if k == "PR_BODY" {
			return body
		}
		return ""
	}, &out, &errb)
	return code, out.String(), errb.String()
}

func TestTestsOnlyCommand(t *testing.T) {
	t.Run("a src change with a test added is ok", func(t *testing.T) {
		dir := testsOnlyRepo(t)
		commit(t, dir, "src/a.ts", "export const a = 2;\n", "src", "Dev <dev@x.io>")
		commit(t, dir, "tests/a.test.ts", "test(\"case\", () => {\n  expect(a()).toBe(1);\n  expect(a()).toBe(2);\n});\n", "t", "Dev <dev@x.io>")
		code, out, errs := runTestsOnlyCmd(dir, "", "main", "HEAD")
		if code != 0 || out != "check-tests-only: ok\n" {
			t.Fatalf("code %d, out %q, stderr %q", code, out, errs)
		}
	})
	t.Run("a removed assertion fails without a reason", func(t *testing.T) {
		dir := testsOnlyRepo(t)
		commit(t, dir, "src/a.ts", "export const a = 2;\n", "src", "Dev <dev@x.io>")
		commit(t, dir, "tests/a.test.ts", "test(\"case\", () => {\n});\n", "t", "Dev <dev@x.io>")
		code, _, errs := runTestsOnlyCmd(dir, "", "main", "HEAD")
		if code != 1 || !strings.HasPrefix(errs, "check-tests-only:\n- removed-assertion: tests/a.test.ts: 1 fewer assertions, first removed: expect(a()).toBe(1);") ||
			!strings.Contains(errs, `state why in a "Test change reason:" line in the PR body`) {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("the same change passes with a reason and lists what it weakened", func(t *testing.T) {
		dir := testsOnlyRepo(t)
		commit(t, dir, "src/a.ts", "export const a = 2;\n", "src", "Dev <dev@x.io>")
		commit(t, dir, "tests/a.test.ts", "test(\"case\", () => {\n});\n", "t", "Dev <dev@x.io>")
		code, out, errs := runTestsOnlyCmd(dir, "## Summary\n\n"+reason+"\n", "main", "HEAD")
		if code != 0 || !strings.HasPrefix(out, "check-tests-only: reason given:\n- removed-assertion: tests/a.test.ts") {
			t.Fatalf("code %d, out %q, stderr %q", code, out, errs)
		}
	})
	t.Run("only tests touched fails", func(t *testing.T) {
		dir := testsOnlyRepo(t)
		commit(t, dir, "tests/b.test.ts", "test(\"b\", () => {\n  expect(1).toBe(1);\n});\n", "t", "Dev <dev@x.io>")
		code, _, errs := runTestsOnlyCmd(dir, "", "main", "HEAD")
		if code != 1 || !strings.Contains(errs, "only-tests: : every changed file is a test") {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("the diff is against the merge base", func(t *testing.T) {
		dir := testsOnlyRepo(t)
		commit(t, dir, "src/a.ts", "export const a = 3;\n", "src", "Dev <dev@x.io>")
		git(t, dir, nil, "checkout", "-q", "main")
		commit(t, dir, "tests/b.test.ts", "test(\"b\", () => {\n  expect(1).toBe(1);\n});\n", "main moved", "Dev <dev@x.io>")
		git(t, dir, nil, "checkout", "-q", "work")
		if code, out, errs := runTestsOnlyCmd(dir, "", "main", "work"); code != 0 {
			t.Fatalf("code %d, out %q, stderr %q: a change on main must not count against the branch", code, out, errs)
		}
	})
	t.Run("usage and a bad range exit 2", func(t *testing.T) {
		dir := testsOnlyRepo(t)
		if code, _, errs := runTestsOnlyCmd(dir, "", "main"); code != 2 || !strings.Contains(errs, "usage: prcheck tests-only <base> <head>") {
			t.Fatalf("usage: code %d, stderr %q", code, errs)
		}
		if code, _, errs := runTestsOnlyCmd(dir, "", "nope", "HEAD"); code != 2 || !strings.Contains(errs, "git diff nope...HEAD") {
			t.Fatalf("bad base: code %d, stderr %q", code, errs)
		}
	})
}
