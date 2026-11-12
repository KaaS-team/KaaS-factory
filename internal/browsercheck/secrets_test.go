package browsercheck

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRedactForms(t *testing.T) {
	const v = `p"ss<w>&rd`
	s := Secrets{{Name: "pw", Value: v}}
	b := []byte(v)
	for name, form := range map[string]string{
		"raw":        v,
		"json":       `p\"ss<w>&rd`,
		"html":       "p&#34;ss&lt;w&gt;&amp;rd",
		"upper":      strings.ToUpper(v),
		"lower":      strings.ToLower(v),
		"reversed":   "dr&>w<ss\"p",
		"base64":     base64.StdEncoding.EncodeToString(b),
		"base64 raw": base64.RawStdEncoding.EncodeToString(b),
		"base64 url": base64.URLEncoding.EncodeToString(b),
		"hex":        hex.EncodeToString(b),
		"hex upper":  strings.ToUpper(hex.EncodeToString(b)),
		"url":        url.QueryEscape(v),
		"url path":   strings.ReplaceAll(url.QueryEscape(v), "+", "%20"),
	} {
		got := s.Redact("before " + form + " after")
		if strings.Contains(got, form) || !strings.Contains(got, "<secret:pw>") {
			t.Errorf("%s form not redacted: %q", name, got)
		}
	}
}

func TestRedactBoundaries(t *testing.T) {
	tests := []struct {
		name, value, in, want string
	}{
		{"short value only as a whole word", "9", "year 2019, code 9.", "year 2019, code <secret:s>."},
		{"short value at ends", "ab", "ab and cab and ab", "<secret:s> and cab and <secret:s>"},
		{"long value anywhere", "hunter2!", "xhunter2!x", "x<secret:s>x"},
		{"empty value redacts nothing", "", "plain text", "plain text"},
		{"longest form first", "abcd", "ABCD abcd", "<secret:s> <secret:s>"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := (Secrets{{Name: "s", Value: tt.value}}).Redact(tt.in); got != tt.want {
				t.Errorf("got %q, want %q", got, tt.want)
			}
		})
	}
}

func TestSecretLookup(t *testing.T) {
	s := Secrets{{Name: "any", Value: "1"}, {Name: "scoped", Value: "2", Domain: "example.com"}}
	tests := []struct {
		name, secret, host, want, wantErr string
	}{
		{"unscoped on any host", "any", "127.0.0.1", "1", ""},
		{"scoped on exact host", "scoped", "example.com", "2", ""},
		{"scoped on subdomain", "scoped", "app.example.com", "2", ""},
		{"scoped on look-alike host", "scoped", "evilexample.com", "", "domain"},
		{"scoped on other host", "scoped", "evil.com", "", "domain"},
		{"scoped with unknown host fails closed", "scoped", "", "", "domain"},
		{"unknown name lists names only", "nope", "example.com", "", "known: any, scoped"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := s.Lookup(tt.secret, tt.host)
			if tt.wantErr == "" {
				if err != nil || got != tt.want {
					t.Fatalf("got %q, %v", got, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tt.wantErr) {
				t.Fatalf("err = %v, want it to contain %q", err, tt.wantErr)
			}
			if strings.Contains(err.Error(), "1") || strings.Contains(err.Error(), "2") {
				t.Errorf("error shows a value: %v", err)
			}
		})
	}
}

func TestLoadSecrets(t *testing.T) {
	p := filepath.Join(t.TempDir(), "s.yaml")
	if err := os.WriteFile(p, []byte("plain: abc\nscoped: {value: def, domain: example.com}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	s, err := LoadSecrets(p)
	if err != nil || len(s) != 2 || s[0].Value != "abc" || s[1].Domain != "example.com" {
		t.Fatalf("got %+v, %v", s, err)
	}
	for name, body := range map[string]string{"no value": "a: {domain: x.com}\n", "not a map": "- a\n", "empty": "a: ''\n"} {
		_ = os.WriteFile(p, []byte(body), 0o600)
		if _, err := LoadSecrets(p); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	if _, err := LoadSecrets(filepath.Join(t.TempDir(), "missing")); err == nil {
		t.Error("missing file: want an error")
	}
}

func TestParseTypeSecret(t *testing.T) {
	steps, err := ParseSteps([]byte("- type_secret: {name: pw, selector: '#name'}\n"))
	if err != nil || steps[0].Kind != "type_secret" || steps[0].Name != "pw" || steps[0].Selector != "#name" {
		t.Fatalf("got %+v, %v", steps, err)
	}
	for _, bad := range []string{"- type_secret: {name: pw}\n", "- type_secret: {selector: '#a'}\n", "- type_secret: pw\n"} {
		if _, err := ParseSteps([]byte(bad)); err == nil {
			t.Errorf("%q: want an error", bad)
		}
	}
}

func runSecret(t *testing.T, s Secrets, steps string) (Result, string) {
	t.Helper()
	parsed, err := ParseSteps([]byte(steps))
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	res := Run(ctx, Options{Steps: parsed, OutDir: t.TempDir(), Secrets: s, Look: func(string) (string, error) { return chromePath(t), nil }})
	return res, res.Message
}

// TestTypeSecretNeverPrinted types a secret into a page that echoes it, then fails a step whose
// needle is the secret: the failure message must name the secret, not show it.
func TestTypeSecretNeverPrinted(t *testing.T) {
	srv := server(t)
	const v = "s3cr3t-Val_ue"
	base := fmt.Sprintf("- goto: %s/\n- type_secret: {name: pw, selector: '#name'}\n- click: '#go'\n", srv.URL)
	if res, _ := runSecret(t, Secrets{{Name: "pw", Value: v}}, base+"- expect_text: Hi "+v+"\n"); res.Failed > 0 {
		t.Fatalf("the typed secret did not reach the page: %s", res.Message)
	}
	res, msg := runSecret(t, Secrets{{Name: "pw", Value: v}}, base+"- expect_text: nope "+v+"\n")
	if res.Failed == 0 || strings.Contains(msg, v) || !strings.Contains(msg, "<secret:pw>") {
		t.Errorf("message %q", msg)
	}
	_, msg = runSecret(t, Secrets{{Name: "pw", Value: v, Domain: "example.com"}}, base)
	if !strings.Contains(msg, "domain") || strings.Contains(msg, v) {
		t.Errorf("scoped secret on another host: %q", msg)
	}
	_, msg = runSecret(t, Secrets{{Name: "pw", Value: v}}, strings.ReplaceAll(base, "name: pw", "name: other"))
	if !strings.Contains(msg, "known: pw") || strings.Contains(msg, v) {
		t.Errorf("unknown name: %q", msg)
	}
}
