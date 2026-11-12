package packs

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"os"
	"strings"
)

// SigSuffix is appended to a file's path to name its detached signature: base64 of an ed25519
// signature over the file's exact bytes.
const SigSuffix = ".sig"

// ReadFileSigned returns the bytes of path only when path+SigSuffix holds a signature that verifies
// against pub. A missing key, missing or malformed signature, or a mismatch is an error and no bytes.
func ReadFileSigned(path string, pub ed25519.PublicKey) ([]byte, error) {
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("%s: no public key configured, refusing unsigned content", path)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	raw, err := os.ReadFile(path + SigSuffix)
	if err != nil {
		return nil, fmt.Errorf("%s: signature file missing: %w", path, err)
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return nil, fmt.Errorf("%s: signature is not base64: %w", path, err)
	}
	if !ed25519.Verify(pub, data, sig) {
		return nil, fmt.Errorf("%s: signature does not verify against the configured key", path)
	}
	return data, nil
}

// ReadLockSigned reads and parses factory.lock at path only when its signature verifies against pub.
func ReadLockSigned(path string, pub ed25519.PublicKey) (*Lock, error) {
	data, err := ReadFileSigned(path, pub)
	if err != nil {
		return nil, err
	}
	return ParseLock(data)
}
