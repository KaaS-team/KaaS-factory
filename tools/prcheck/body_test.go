// Ported from scripts/check-pr-body.ts at ts-final
package main

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// repoTemplate is the real template the checked-in workflow lints against.
func repoTemplate(t *testing.T) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", ".github", "pull_request_template.md"))
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// filled renders a body with every template section, the given overrides applied.
func filled(over map[string]string) string {
	order := []string{"Summary", "Plan", "Gate evidence", "Verify verdict", "Confidence", "Risk and rollback"}
	sec := map[string]string{
		"Summary":           "One thing changed.\n\nCloses #12",
		"Plan":              "Planned in #12.",
		"Gate evidence":     "make check: 412 pass, 0 fail",
		"Verify verdict":    "AC-1 pass",
		"Confidence":        "| Gate | make check green |",
		"Risk and rollback": "Low; revert the commit.",
	}
	for k, v := range over {
		sec[k] = v
	}
	var sb strings.Builder
	for i, k := range order {
		if i > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString("## " + k + "\n\n" + sec[k] + "\n")
	}
	return sb.String()
}

func TestBodyProblems(t *testing.T) {
	tpl := repoTemplate(t)
	cases := []struct {
		name string
		body string
		want []string
	}{
		{"a body with every template section passes", filled(nil), nil},
		{"an empty or comment-only section is refused", filled(map[string]string{"Gate evidence": "<!-- verbatim -->"}),
			[]string{`section "Gate evidence" is empty`}},
		{"a Summary holding only a bare Closes line is refused", filled(map[string]string{"Summary": "Closes #"}),
			[]string{`section "Summary" is empty`}},
		{"a real verdict is accepted", filled(map[string]string{"Verify verdict": "Pass: 412 tests, 0 failures, mutations 3/3 red"}), nil},
		{"gate evidence with prose and no digit is refused", filled(map[string]string{"Gate evidence": "make check passed"}),
			[]string{`section "Gate evidence" has no output`}},
		{"gate evidence in a fenced block is accepted", filled(map[string]string{"Gate evidence": "```\nmake check: ok\n```"}), nil},
		{"the factory's own shape passes",
			"## What changed\n\nGoal.\n\n## Acceptance\n\n| a | pass |\n\n## Verify verdict\n\nPending\n\nThe receipt is in the run-details comment on #7.", nil},
		{"a session link is refused in either shape", filled(nil) + "\nhttps://claude.ai/code/session_x",
			[]string{"the body links a Claude session"}},
		{"a Claude-Session trailer is refused", filled(nil) + "\nClaude-Session: abc",
			[]string{"the body links a Claude session"}},
		{"the factory shape still refuses a session link",
			"## What changed\n\nG.\n\n## Acceptance\n\nx\n\nrun-details comment on #7 https://claude.ai/code/s",
			[]string{"the body links a Claude session"}},
		// pr-body-lint.test.ts: the lint that stops a placeholder verdict from opening a PR.
		{"a lint body with a placeholder verdict names the section", filled(map[string]string{"Verify verdict": "Pending CI"}),
			[]string{`section "Verify verdict" is a placeholder`}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := bodyProblems(tc.body, tpl); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %q, want %q", got, tc.want)
			}
		})
	}
}

func TestBodyOneParagraphNamesEverySection(t *testing.T) {
	got := bodyProblems("check-mutations was red.", repoTemplate(t))
	if len(got) != 6 || !strings.Contains(got[0], `missing section "Summary"`) {
		t.Fatalf("got %q, want 6 problems starting with the Summary section", got)
	}
}

func TestBodyPlaceholderVerdicts(t *testing.T) {
	tpl := repoTemplate(t)
	for _, v := range []string{"Pending CI", "pending", "TBD", "TODO", "N/A", "n/a", "NA", "pass", "Passed.", "OK", "None"} {
		t.Run(v, func(t *testing.T) {
			want := []string{`section "Verify verdict" is a placeholder`}
			if got := bodyProblems(filled(map[string]string{"Verify verdict": v}), tpl); !reflect.DeepEqual(got, want) {
				t.Fatalf("got %q, want %q", got, want)
			}
		})
	}
}

func TestTemplateHasConfidenceLayerRows(t *testing.T) {
	section := strings.SplitN(repoTemplate(t), "## Confidence", 2)[1]
	section = strings.SplitN(section, "\n## ", 2)[0]
	for _, layer := range []string{"Gate", "Proof (fails on base)", "Changed-line mutants", "Review findings with evidence", "UI preview and smoke"} {
		if !strings.Contains(section, "| "+layer+" |") {
			t.Errorf("Confidence section has no %q row", layer)
		}
	}
}

// bodyRepo is a temp dir holding the template, so the sections come from a file and not from the code.
func bodyRepo(t *testing.T, template string) string {
	t.Helper()
	dir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dir, ".github"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, ".github", "pull_request_template.md"), []byte(template), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func runBodyCmd(dir string, env map[string]string, args ...string) (int, string, string) {
	var out, errb bytes.Buffer
	code := run(dir, append([]string{"body"}, args...), func(k string) string { return env[k] }, &out, &errb)
	return code, out.String(), errb.String()
}

func TestBodyCommand(t *testing.T) {
	dir := bodyRepo(t, repoTemplate(t))
	file := filepath.Join(t.TempDir(), "body.md")
	write := func(s string) {
		if err := os.WriteFile(file, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	t.Run("PR_BODY complete exits 0", func(t *testing.T) {
		code, out, _ := runBodyCmd(dir, map[string]string{"PR_BODY": filled(nil)})
		if code != 0 || out != "check-pr-body: ok\n" {
			t.Fatalf("code %d, out %q", code, out)
		}
	})
	t.Run("PR_BODY short exits 1", func(t *testing.T) {
		code, _, errs := runBodyCmd(dir, map[string]string{"PR_BODY": "short"})
		if code != 1 || !strings.Contains(errs, "check-pr-body: the PR body does not follow .github/pull_request_template.md\n- missing section") {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("unset PR_BODY is an empty body", func(t *testing.T) {
		if code, _, _ := runBodyCmd(dir, nil); code != 1 {
			t.Fatalf("code %d, want 1", code)
		}
	})
	t.Run("--file placeholder verdict exits 1 with the message", func(t *testing.T) {
		write(filled(map[string]string{"Verify verdict": "Pending CI"}))
		code, _, errs := runBodyCmd(dir, nil, "--file", file)
		if code != 1 || !strings.Contains(errs, `section "Verify verdict" is a placeholder`) {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("--file complete body exits 0", func(t *testing.T) {
		write(filled(nil))
		if code, _, errs := runBodyCmd(dir, nil, "--file", file); code != 0 {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("--file without a path exits 1", func(t *testing.T) {
		code, _, errs := runBodyCmd(dir, nil, "--file")
		if code != 1 || !strings.Contains(errs, "check-pr-body: --file needs a path") {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("the sections come from the template file", func(t *testing.T) {
		custom := bodyRepo(t, "## Alpha\n\n<!-- x -->\n\n## Beta\n")
		code, _, errs := runBodyCmd(custom, map[string]string{"PR_BODY": "## Alpha\n\ntext\n"})
		if code != 1 || !strings.Contains(errs, `missing section "Beta"`) || strings.Contains(errs, "Summary") {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
		if code, _, errs := runBodyCmd(custom, map[string]string{"PR_BODY": "## Alpha\n\na\n\n## Beta\n\nb\n"}); code != 0 {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
	t.Run("a missing template is an error", func(t *testing.T) {
		code, _, errs := runBodyCmd(t.TempDir(), map[string]string{"PR_BODY": "x"})
		if code != 2 || !strings.Contains(errs, "pull_request_template.md") {
			t.Fatalf("code %d, stderr %q", code, errs)
		}
	})
}
