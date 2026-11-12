package lintdelta

import (
	"context"
	"errors"
	"regexp"
	"strings"
	"testing"
)

const good = "package p\n\nfunc a() int {\n\treturn 1\n}\n"

func TestCheck(t *testing.T) {
	broken := "package p\n\nfunc a() int {\n\treturn 1\n}\n\nfunc b( {\n}\n" // pre-existing syntax error at line 7
	tests := []struct {
		name          string
		before, after string
		edit          Edit
		reject        bool
	}{
		{"clean edit passes", good, strings.Replace(good, "return 1", "return 2", 1), Edit{4, 4, 1}, false},
		{"syntax-breaking edit is rejected", good, strings.Replace(good, "return 1", "return (", 1), Edit{4, 4, 1}, true},
		{"edit on already-broken file passes when no new errors", broken, strings.Replace(broken, "return 1", "return 2", 1), Edit{4, 4, 1}, false},
		{"insert above shifts the old error and still passes", broken, strings.Replace(broken, "func a", "// c1\n// c2\nfunc a", 1), Edit{3, 2, 2}, false},
		{"reworking the broken line keeps its error out of the delta", broken, strings.Replace(broken, "func b( {", "\nfunc b( {", 1), Edit{7, 7, 2}, false},
		{"edit on broken file that adds an error is rejected", broken, strings.Replace(broken, "return 1", "return )", 1), Edit{4, 4, 1}, true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			v, err := Check(context.Background(), GoSyntax{}, "p.go", tc.before, tc.after, tc.edit)
			if err != nil {
				t.Fatal(err)
			}
			if v.Rejected != tc.reject {
				t.Fatalf("rejected=%v want %v: %+v", v.Rejected, tc.reject, v.New)
			}
			if tc.reject {
				m := v.Message()
				if !strings.Contains(m, "return 1") || !strings.Contains(m, "return") || v.Before == v.After {
					t.Fatalf("message must carry both windows:\n%s", m)
				}
			} else if v.Message() != "" {
				t.Fatal("passing verdict has a message")
			}
		})
	}
}

type failing struct{}

func (failing) Lint(context.Context, string, string) ([]Finding, error) {
	return nil, errors.New("boom")
}

func TestCheckLinterError(t *testing.T) {
	if _, err := Check(context.Background(), failing{}, "p.go", good, good, Edit{1, 1, 1}); err == nil {
		t.Fatal("want error")
	}
}

func TestCommandParsesOutput(t *testing.T) {
	c := Command{
		Argv:    []string{"sh", "-c", "cat >/dev/null; echo 'stdin:3:1: E999 bad thing'; exit 1"},
		Pattern: regexp.MustCompile(`:(?P<line>\d+):\d+: (?P<code>\w+) (?P<text>.+)`),
	}
	got, err := c.Lint(context.Background(), "x.py", "x")
	if err != nil || len(got) != 1 || got[0] != (Finding{3, "E999", "bad thing"}) {
		t.Fatalf("got %v %v", got, err)
	}
	if _, err := (Command{Argv: []string{"definitely-not-a-tool"}, Pattern: c.Pattern}).Lint(context.Background(), "", ""); err == nil {
		t.Fatal("want error for missing tool")
	}
}
