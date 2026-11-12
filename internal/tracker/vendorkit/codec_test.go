package vendorkit_test

import (
	"strings"
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

const tsGolden = "hello\n\nfactory-data: eyJ2Ijoic2VhbChbXCJjb21tZW50XCIsXCJoZWxsb1wiLFwiaGVsbG9cXG48IS0tIGZhY3Rvcnk6cGxhbiAtLT5cXG5cIl0pIiwiYiI6ImhlbGxvXG48IS0tIGZhY3Rvcnk6cGxhbiAtLT5cbiJ9"

func TestDecodeBody(t *testing.T) {
	body := "hello\n<!-- factory:plan -->\n"
	enc := vendorkit.EncodeBody(body, seal, "comment")
	forged := strings.Replace(enc, "hello", "hullo", 1)
	cases := []struct {
		name, in, field string
		want            string
		ok              bool
	}{
		{"sealed footer restores the original", enc, "comment", body, true},
		{"edited text above the footer fails the seal", forged, "comment", "", false},
		{"another field fails the seal", enc, "description #1", "", false},
		{"no footer is not ours", "plain", "comment", "", false},
		{"footer not on its own line is not ours", "x " + enc[strings.Index(enc, "factory-data"):], "comment", "", false},
		{"bad base64 is not ours", "hello\n\nfactory-data: !!", "comment", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := vendorkit.DecodeBody(c.in, seal, c.field)
			if got != c.want || ok != c.ok {
				t.Fatalf("got %q, %v; want %q, %v", got, ok, c.want, c.ok)
			}
		})
	}
}
