package egress

import (
	"strings"
	"testing"
)

func run(m *Masker, chunks ...string) string {
	var sb strings.Builder
	for _, c := range chunks {
		sb.WriteString(m.Feed(c))
	}
	sb.WriteString(m.Flush())
	return sb.String()
}

func TestMaskerStream(t *testing.T) {
	cases := []struct {
		name    string
		secrets []string
		chunks  []string
		want    string
	}{
		{"no secrets passes through", nil, []string{"a", "b"}, "ab"},
		{"whole in one chunk", []string{"hunter2"}, []string{"pw=hunter2!"}, "pw=<secret-hidden>!"},
		{"split across a boundary", []string{"hunter2"}, []string{"pw=hun", "ter2!"}, "pw=<secret-hidden>!"},
		{"split one byte at a time", []string{"hunter2"}, strings.Split("pw=hunter2!", ""), "pw=<secret-hidden>!"},
		{"split three ways", []string{"hunter2"}, []string{"h", "unte", "r2"}, "<secret-hidden>"},
		{"partial prefix that never completes", []string{"hunter2"}, []string{"hun", "tel"}, "huntel"},
		{"two occurrences", []string{"abc"}, []string{"abc-a", "bc"}, "<secret-hidden>-<secret-hidden>"},
		{"longest first when one contains the other", []string{"tok", "token123"}, []string{"x token123 y"}, "x <secret-hidden> y"},
		{"regex metacharacters are literal", []string{"a.b*c"}, []string{"a.b*c aXb*c"}, "<secret-hidden> aXb*c"},
		{"empty chunks are fine", []string{"abc"}, []string{"", "ab", "", "c", ""}, "<secret-hidden>"},
		{"empty secret values are ignored", []string{"", "abc"}, []string{"abc"}, "<secret-hidden>"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := run(NewMasker(c.secrets), c.chunks...); got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestMaskerHoldsBackOnlyWhatCouldStillGrowIntoASecret(t *testing.T) {
	m := NewMasker([]string{"hunter2"}) // 7 bytes: hold back at most 6
	if got := m.Feed("0123456789"); got != "0123" {
		t.Fatalf("released %q, want the 4 bytes that cannot start a match", got)
	}
	if got := m.Flush(); got != "456789" {
		t.Fatalf("flush = %q", got)
	}
	if got := m.Flush(); got != "" {
		t.Fatalf("second flush = %q", got)
	}
}

func TestMaskerNeverEmitsASecretByteBeforeItIsComplete(t *testing.T) {
	const secret = "supersecretvalue"
	input := "xx " + secret + " yy"
	for split := 0; split <= len(input); split++ {
		m := NewMasker([]string{secret})
		out := m.Feed(input[:split]) + m.Feed(input[split:]) + m.Flush()
		if strings.Contains(out, secret) || out != "xx <secret-hidden> yy" {
			t.Fatalf("split %d: %q", split, out)
		}
	}
}

func TestMaskString(t *testing.T) {
	m := NewMasker([]string{"abc", "abcdef"})
	if got := m.MaskString("1abcdef2 abc"); got != "1<secret-hidden>2 <secret-hidden>" {
		t.Fatalf("got %q", got)
	}
}
