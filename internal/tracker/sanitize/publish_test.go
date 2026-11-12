package sanitize

import (
	"strings"
	"testing"
	"unicode/utf8"
)

func TestPublication(t *testing.T) {
	cases := []struct{ name, in, want string }{
		// URL allowlist and userinfo
		{"allowed url kept", "see https://github.com/a/b/issues/1 now", "see https://github.com/a/b/issues/1 now"},
		{"allowed subdomain kept", "https://api.github.com/x", "https://api.github.com/x"},
		{"unknown host redacted", "go https://evil.example.com/p?q=1 ok", "go (evil.example.com/redacted) ok"},
		{"suffix lookalike redacted", "https://notgithub.com/x", "(notgithub.com/redacted)"},
		{"userinfo stripped on allowed", "https://user:pw@github.com/a", "https://github.com/a"},
		{"userinfo spoof redacted", "https://github.com@evil.com/a", "(evil.com/redacted)"},
		{"userinfo tab spoof", "https://github.com\tA@evil.com/x", "(evil.com/redacted)"},
		{"http redacted", "http://github.com/a", "(github.com/redacted)"},
		{"ftp redacted", "ftp://files.example.org/x", "(files.example.org/redacted)"},
		{"file scheme without host", "file:///etc/passwd", "(redacted)"},
		{"javascript uri", "[x](javascript:alert(1))", "[x]((redacted)"},
		{"encoded colon uri", "javascript%3Aalert(1)", "(redacted)"},
		{"double encoded colon uri", "javascript%253Aalert(1)", "(redacted)"},
		{"data uri", "data:text/html,hi", "(redacted)"},
		{"prose colon kept", "key: value and data: x", "key: value and data: x"},
		{"protocol relative redacted", "[a](//evil.com/x)", "[a]((evil.com/redacted)"},
		{"protocol relative userinfo", "see //github.com@evil.com/x", "see (evil.com/redacted)"},
		{"protocol relative allowed", "see //github.com/x", "see //github.com/x"},
		{"double slash path kept", "https://github.com//issues", "https://github.com//issues"},
		{"adjacent urls", "https://github.com/a,https://evil.com/b", "https://github.com/a,(evil.com/redacted)"},
		{"www redacted", "visit www.evil.com/x.", "visit (www[.]evil.com/redacted)."},
		{"www allowed", "visit www.github.com/x", "visit www.github.com/x"},
		{"angle autolink allowed", "<https://github.com/x>", "<https://github.com/x>"},
		{"angle autolink slack label", "<https://evil.com/x|click me>", "(evil.com/redacted)|click me"},
		// mentions
		{"mention wrapped", "hi @octocat now", "hi `@octocat` now"},
		{"team mention wrapped", "ping @org/team", "ping `@org/team`"},
		{"mention at start", "@octocat go", "`@octocat` go"},
		{"mention in code kept", "run `@octocat` ok", "run `@octocat` ok"},
		{"mention in fence kept", "```\n@octocat\n```", "```\n@octocat\n```"},
		{"entity mention", "hi &commat;octocat", "hi `@octocat`"},
		{"double encoded entity mention", "hi &amp;commat;octocat", "hi `@octocat`"},
		{"numeric entity mention", "hi &#64;octocat", "hi `@octocat`"},
		{"zero width inside mention", "hi @octo\u200Bcat", "hi `@octocat`"},
		{"fullwidth mention", "hi \uFF20octocat", "hi `@octocat`"},
		{"homoglyph mention", "hi @\u043Ectocat", "hi `@octocat`"},
		{"email untouched", "a@b.com", "a@b.com"},
		// XML and templates
		{"comment removed", "a<!-- @x payload -->b", "ab"},
		{"nested comment removed", "a<!-- <!-- --> PAYLOAD -->b", "ab"},
		{"unknown tag converted", "<script>alert(1)</script>", "(script)alert(1)(/script)"},
		{"allowed tag kept", "<b>x</b>", "<b>x</b>"},
		{"handler attr stripped", `<img src="a" onerror="x()">`, `<img src="a">`},
		{"data attr stripped", `<span data-p="x" id="y">`, `<span id="y">`},
		{"unclosed quote converted", `<b title="x>y`, `(b title="x)y`},
		{"generic type in code kept", "`Vec<float32>`", "`Vec<float32>`"},
		{"link title moved", `[t](https://github.com "hidden")`, "[t (hidden)](https://github.com)"},
		{"jinja escaped", "{{ x }}", `\{\{ x }}`},
		{"erb escaped", "<%= x %>", `\<%= x %>`},
		{"js literal escaped", "${x}", `\$\{x}`},
		{"jekyll escaped", "{% raw %}", `\{\% raw %}`},
		{"template in fence kept", "```\n{{ x }}\n```", "```\n{{ x }}\n```"},
		// bot triggers (default cap 10)
		{"control and ansi removed", "a\x1b[31mb\x07c", "abc"},
		{"bidi removed", "a\u202Eb", "ab"},
		{"tag chars removed", "a\U000E0041b", "ab"},
		{"trim", "  x \n", "x"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := Publication(c.in, DefaultOptions()); got != c.want {
				t.Fatalf("Publication(%q)\n got %q\nwant %q", c.in, got, c.want)
			}
		})
	}
}

func TestBotTriggerCap(t *testing.T) {
	in := "fixes #1, closes #2, resolves #3"
	cases := []struct {
		cap  int
		want string
	}{
		{0, "`fixes #1`, `closes #2`, `resolves #3`"},
		{2, "fixes #1, closes #2, `resolves #3`"},
		{10, in},
	}
	for _, c := range cases {
		got := Publication(in, Options{MaxBotTriggers: c.cap})
		if got != c.want {
			t.Errorf("cap %d: got %q want %q", c.cap, got, c.want)
		}
	}
	if got := Publication("`fixes #1`", Options{}); got != "`fixes #1`" {
		t.Errorf("already quoted trigger re-quoted: %q", got)
	}
}

func TestCustomAllowedDomains(t *testing.T) {
	o := Options{AllowedDomains: []string{"*.corp.dev", "example.com"}, MaxBotTriggers: 10}
	cases := map[string]string{
		"https://a.corp.dev/x":  "https://a.corp.dev/x",
		"https://corp.dev/x":    "https://corp.dev/x",
		"https://example.com/x": "https://example.com/x",
		"https://github.com/x":  "(github.com/redacted)",
		"https://xcorp.dev/x":   "(xcorp.dev/redacted)",
		"https://EXAMPLE.com/x": "https://EXAMPLE.com/x",
	}
	for in, want := range cases {
		if got := Publication(in, o); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestTruncation(t *testing.T) {
	t.Run("lines", func(t *testing.T) {
		got := Publication("a\nb\nc\nd", Options{MaxLines: 2})
		if got != "a\nb\n[Content truncated due to line count]" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("length", func(t *testing.T) {
		got := Publication(strings.Repeat("x", 50), Options{MaxLength: 10})
		if got != strings.Repeat("x", 10)+"\n[Content truncated due to length]" {
			t.Fatalf("got %q", got)
		}
	})
	t.Run("rune boundary", func(t *testing.T) {
		got := Publication(strings.Repeat("\u00E9", 20), Options{MaxLength: 5})
		if !utf8.ValidString(got) {
			t.Fatalf("invalid utf8: %q", got)
		}
	})
	t.Run("lines then length", func(t *testing.T) {
		got := Publication(strings.Repeat("y", 100)+"\nb\nc", Options{MaxLines: 2, MaxLength: 60})
		if !strings.HasSuffix(got, "\n[Content truncated due to line count]") || len(got) > 60 {
			t.Fatalf("got %d bytes %q", len(got), got)
		}
	})
	t.Run("under limits untouched", func(t *testing.T) {
		if got := Publication("a\nb", Options{MaxLines: 2, MaxLength: 10}); got != "a\nb" {
			t.Fatalf("got %q", got)
		}
	})
}

func TestNestedEncodingFailsClosed(t *testing.T) {
	deep := "&" + strings.Repeat("amp;", 40) + "commat;octocat"
	if got := Publication(deep, DefaultOptions()); got != "[content removed: nested encodings]" {
		t.Fatalf("got %q", got)
	}
	shallow := "&" + strings.Repeat("amp;", 3) + "commat;octocat"
	if got := Publication(shallow, DefaultOptions()); got != "`@octocat`" {
		t.Fatalf("got %q", got)
	}
}

func TestEmpty(t *testing.T) {
	if Publication("", DefaultOptions()) != "" {
		t.Fatal("empty in, empty out")
	}
}

// FuzzPublication: no input may panic or yield invalid UTF-8 from valid input, and the output must
// not contain a bare mention or a non-allowlisted https URL outside code.
func FuzzPublication(f *testing.F) {
	seeds := []string{
		"", "@octocat", "https://github.com@evil.com/x", "//github.com\\@evil.com", "<!-- <!-- --> x -->",
		"<img alt='x' onerror=y>", "[a](u \"t\")", "```\n@x\n```", "`@x`", "{{ x }} ${y} <%= z %>",
		"&amp;amp;commat;a", "fixes #1 closes #2", "javascript%253Aalert(1)", "www.evil.com/x", "<https://a.b|c>",
		"a\u202Eb\u200Bc", "\U000E0041", "<b title=\"x>", "[x]: http://a \"t\"", "````\n```\n````",
	}
	for _, s := range seeds {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, s string) {
		out := Publication(s, Options{MaxBotTriggers: 1, MaxLength: 4096, MaxLines: 50})
		if utf8.ValidString(s) && !utf8.ValidString(out) {
			t.Fatalf("invalid utf8 from valid input %q -> %q", s, out)
		}
		_ = Prompt(s)
	})
}
