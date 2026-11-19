package redact

import (
	"strings"
	"testing"
)

// Samples are assembled at run time so no scanner sees a whole token in the source.
func rep(prefix string, n int) string { return prefix + strings.Repeat("a1", n)[:n] }

// Samples lists one token of every kind the redactor covers. Callers' tests walk it too.
func Samples() map[string]string {
	return map[string]string{
		"github ghp":         rep("ghp_", 36),
		"github ghs":         rep("ghs_", 36),
		"github gho":         rep("gho_", 36),
		"github fine":        rep("github_pat_", 40),
		"anthropic":          rep("sk-ant-api03-", 40),
		"openai":             rep("sk-", 40),
		"openai project":     rep("sk-proj-", 40),
		"aws access key":     "AKIA" + strings.Repeat("Q", 16),
		"aws session key":    "ASIA" + strings.Repeat("Z", 16),
		"slack bot":          "xoxb-" + "123456789012-abcdefghij",
		"slack user":         "xoxp-" + "123456789012-abcdefghij",
		"slack app":          "xapp-" + "1-A0123456789-1234567890-abcdef",
		"private key header": "-----BEGIN RSA PRIVATE KEY-----",
		"jwt":                "eyJ" + strings.Repeat("a", 12) + ".eyJ" + strings.Repeat("b", 12) + "." + strings.Repeat("c", 12),
	}
}

func TestSecretsRedactsEveryKind(t *testing.T) {
	for name, tok := range Samples() {
		t.Run(name, func(t *testing.T) {
			got := Secrets("a " + tok + " b")
			if strings.Contains(got, tok) || !strings.Contains(got, "[REDACTED_") || !Has(tok) {
				t.Fatalf("not redacted: %q", got)
			}
		})
	}
}

func TestSecretsRedactsWholePrivateKeyBlock(t *testing.T) {
	block := "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----"
	if got := Secrets("x\n" + block + "\ny"); got != "x\n[REDACTED_PRIVATE_KEY]\ny" {
		t.Fatalf("got %q", got)
	}
}

func TestAnthropicKeyKeepsItsOwnTag(t *testing.T) {
	if got := Secrets(rep("sk-ant-", 30)); got != "[REDACTED_ANTHROPIC_KEY]" {
		t.Fatalf("got %q", got)
	}
}

func TestStrictAddsCredentialShapes(t *testing.T) {
	for name, in := range map[string]string{
		"url":    "https://user:hunter2pass@example.com/x",
		"bearer": "Authorization: Bearer abcdefgh12345678",
		"query":  "https://x.test/?token=abc123&ok=1",
	} {
		if got := Strict(in); !strings.Contains(got, "[redacted]") {
			t.Errorf("%s: %q", name, got)
		}
		if got := Secrets(in); got != in {
			t.Errorf("%s: Secrets must leave non-token shapes alone, got %q", name, got)
		}
	}
}

func TestOrdinaryTextStays(t *testing.T) {
	in := "task-list ask-me ghp_ AKIAshort sk-short code=1 Bearer"
	if got := Secrets(in); got != in {
		t.Fatalf("changed: %q", got)
	}
}
