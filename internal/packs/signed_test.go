package packs

import (
	"crypto/ed25519"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadLockSigned(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil)
	l := NewLock()
	body, _ := l.Marshal()
	good := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, body))
	tampered := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("other")))
	cases := []struct {
		name string
		sig  *string // nil: no signature file
		key  ed25519.PublicKey
		want string // error substring, empty for success
	}{
		{"valid", &good, pub, ""},
		{"missing signature", nil, pub, "signature file"},
		{"wrong key", &good, otherPub, "does not verify"},
		{"signature of other content", &tampered, pub, "does not verify"},
		{"not base64", ptr("!!"), pub, "not base64"},
		{"no key configured", &good, nil, "no public key"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			p := filepath.Join(dir, LockFile)
			if err := os.WriteFile(p, body, 0o644); err != nil {
				t.Fatal(err)
			}
			if c.sig != nil {
				if err := os.WriteFile(p+".sig", []byte(*c.sig), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			got, err := ReadLockSigned(p, c.key)
			if c.want == "" {
				if err != nil || got == nil {
					t.Fatalf("got %v, %v", got, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), c.want) || got != nil {
				t.Fatalf("want error with %q and no lock, got %v, %v", c.want, got, err)
			}
		})
	}
}

func ptr(s string) *string { return &s }
