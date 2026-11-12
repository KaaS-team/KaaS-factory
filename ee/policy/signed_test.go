//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy_test

import (
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/ee/policy"
)

func TestLoadSigned(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil)
	sign := func(b string) string { return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte(b))) }
	bad := "rules:\n  - id: a\n    effect: maybe\n    actions: [merge]\n  - id: b\n    effect: allow\n  - id: a\n    effect: deny\n    actions: [fly]\n"
	cases := []struct {
		name  string
		body  string
		sig   *string
		key   ed25519.PublicKey
		wants []string // every substring the error must hold; nil for success
	}{
		{"valid", rules, ptr(sign(rules)), pub, nil},
		{"missing signature", rules, nil, pub, []string{"signature file"}},
		{"wrong key", rules, ptr(sign(rules)), otherPub, []string{"does not verify"}},
		{"edited after signing", rules + "\n", ptr(sign(rules)), pub, []string{"does not verify"}},
		{"no key", rules, ptr(sign(rules)), nil, []string{"no public key"}},
		{"all bad rules listed", bad, ptr(sign(bad)), pub, []string{`"a": effect`, `"b": actions is required`, `duplicate rule id "a"`, `unknown action "fly"`}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			p := filepath.Join(t.TempDir(), "policy.yaml")
			if err := os.WriteFile(p, []byte(c.body), 0o644); err != nil {
				t.Fatal(err)
			}
			if c.sig != nil {
				if err := os.WriteFile(p+".sig", []byte(*c.sig), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			e, err := policy.LoadSigned(p, c.key)
			if c.wants == nil {
				if err != nil || e == nil {
					t.Fatalf("got %v, %v", e, err)
				}
				return
			}
			if err == nil || e != nil {
				t.Fatalf("want a failure and no engine, got %v, %v", e, err)
			}
			for _, w := range c.wants {
				if !strings.Contains(err.Error(), w) {
					t.Errorf("error %q lacks %q", err, w)
				}
			}
		})
	}
}

func TestParsePublicKey(t *testing.T) {
	pub, _, _ := ed25519.GenerateKey(nil)
	good := base64.StdEncoding.EncodeToString(pub)
	for _, c := range []struct {
		name, in string
		ok       bool
	}{{"valid", good, true}, {"padded with newline", good + "\n", true}, {"not base64", "!!", false}, {"short", "AAAA", false}} {
		t.Run(c.name, func(t *testing.T) {
			k, err := policy.ParsePublicKey(c.in)
			if (err == nil) != c.ok || c.ok && !k.Equal(pub) {
				t.Fatalf("got %v, %v", k, err)
			}
		})
	}
}

func ptr(s string) *string { return &s }
