package vendorkit_test

import (
	"testing"

	"github.com/KaaS-team/factory/internal/tracker/vendorkit"
)

func seal(s string) string { return "seal(" + s + ")" }

// Golden produced by src/adapters/trackers/kit.ts encodeBody with the seal above.
func TestEncodeBodyMatchesTS(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"no marker passes through", "plain <b>text</b>", "plain <b>text</b>"},
		{"marker becomes a footer", "hello\n<!-- factory:plan -->\n", tsGolden},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := vendorkit.EncodeBody(c.in, seal, "comment"); got != c.want {
				t.Fatalf("got %q\nwant %q", got, c.want)
			}
		})
	}
}

func TestVisibleOf(t *testing.T) {
	if got := vendorkit.VisibleOf("a\n<!-- m -->\nb\n"); got != "a\nb" {
		t.Fatalf("got %q", got)
	}
}

func TestKeyNumber(t *testing.T) {
	if n, err := vendorkit.KeyNumber("ENG-42"); err != nil || n != 42 {
		t.Fatalf("%d %v", n, err)
	}
	if _, err := vendorkit.KeyNumber("nope"); err == nil {
		t.Fatal("want error")
	}
}

const tsGolden = "hello\n\nfactory-data: eyJ2Ijoic2VhbChbXCJjb21tZW50XCIsXCJoZWxsb1wiLFwiaGVsbG9cXG48IS0tIGZhY3Rvcnk6cGxhbiAtLT5cXG5cIl0pIiwiYiI6ImhlbGxvXG48IS0tIGZhY3Rvcnk6cGxhbiAtLT5cbiJ9"
