package selfupdate

import (
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"strings"
)

// Verifier checks a detached signature over checksums.txt.
type Verifier interface {
	Verify(checksums, signature []byte) error
}

// Ed25519Verifier checks a base64 ed25519 signature made with the release key.
type Ed25519Verifier struct{ Key ed25519.PublicKey }

// Verify returns an error unless signature is a valid signature of checksums.
func (e Ed25519Verifier) Verify(checksums, signature []byte) error {
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(signature)))
	if err != nil || len(e.Key) != ed25519.PublicKeySize || !ed25519.Verify(e.Key, checksums, sig) {
		return errors.New("signature does not match the release key")
	}
	return nil
}

// TrustNote tells the user what protects the download.
func TrustNote(v Verifier) string {
	if v == nil {
		return "no release signature configured: the download is checksum-only"
	}
	return "checksums.txt signature verified"
}
