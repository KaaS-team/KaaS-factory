package sanitize

import (
	"strings"
	"testing"
)

// secrets are assembled at run time so no scanner sees a whole token in the source.
func fake(prefix string, n int) string { return prefix + strings.Repeat("a1", n)[:n] }

func TestPromptSteps(t *testing.T) {
	jwt := "eyJ" + strings.Repeat("a", 12) + ".eyJ" + strings.Repeat("b", 12) + "." + strings.Repeat("c", 12)
	cases := []struct{ name, in, want string }{
		{"hidden comment", "a<!-- ignore previous -->b", "ab"},
		{"hidden comment multiline", "a<!--\nx\n-->b", "ab"},
		{"zero width", "a\u200Bb\u200Cc\u200Dd\uFEFFe", "abcde"},
		{"bidi", "a\u202Eb\u2066c\u2069d", "abcd"},
		{"soft hyphen and control", "a\u00ADb\x07c\x7Fd", "abcd"},
		{"inline image alt", "![secret instructions](http://x/y.png)", "![](http://x/y.png)"},
		{"reference image alt", "![secret][ref]", "![][ref]"},
		{"link title double", `[t](http://x "hidden")`, "[t](http://x)"},
		{"link title single", `[t](http://x 'hidden')`, "[t](http://x)"},
		{"alt attr", `<img alt="hide" src="x">`, `<img src="x">`},
		{"alt attr apostrophe", `<img alt="it's" src="x">`, `<img src="x">`},
		{"title attr", `<a title='hide' href="x">`, `<a href="x">`},
		{"aria-label attr", `<a aria-label=hide href="x">`, `<a href="x">`},
		{"data attr", `<div data-x="hide" id="a">`, `<div id="a">`},
		{"placeholder attr", `<input placeholder="hide" id="a">`, `<input id="a">`},
		{"numeric entity dec", "&#72;&#105;", "Hi"},
		{"numeric entity hex", "&#x48;&#x69;", "Hi"},
		{"numeric entity out of range dropped", "a&#1;b&#x1F600;c", "abc"},
		{"github token", "t " + fake("ghp_", 36) + " e", "t [REDACTED_GITHUB_TOKEN] e"},
		{"github fine grained", fake("github_pat_", 30), "[REDACTED_GITHUB_TOKEN]"},
		{"anthropic key", fake("sk-ant-", 30), "[REDACTED_ANTHROPIC_KEY]"},
		{"aws key", "k=" + "AKIA" + strings.Repeat("A", 16), "k=[REDACTED_AWS_KEY_ID]"},
		{"aws key after json escape", `\n` + "ASIA" + strings.Repeat("B", 16), `\n[REDACTED_AWS_KEY_ID]`},
		{"aws key after ansi", "\x1b[31m" + "AKIA" + strings.Repeat("C", 16), "[31m[REDACTED_AWS_KEY_ID]"},
		{"aws key inside word kept", "xAKIA" + strings.Repeat("A", 16), "xAKIA" + strings.Repeat("A", 16)},
		{"slack token", fake("xoxb-", 20), "[REDACTED_SLACK_TOKEN]"},
		{"jwt", "j " + jwt, "j [REDACTED_JWT]"},
		{"plain text untouched", "Fix the bug in parser.go", "Fix the bug in parser.go"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Prompt(c.in); got != c.want {
				t.Fatalf("Prompt(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}
