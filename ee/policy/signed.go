//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package policy

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/packs"
)

// ParsePublicKey decodes a base64 ed25519 public key as configured by an operator.
func ParsePublicKey(s string) (ed25519.PublicKey, error) {
	b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil {
		return nil, fmt.Errorf("policy key: not base64: %w", err)
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("policy key: want %d bytes, got %d", ed25519.PublicKeySize, len(b))
	}
	return ed25519.PublicKey(b), nil
}

// LoadSigned loads the rules file at path only when path+".sig" verifies against pub and its expires_at, which is required, has not passed, then validates
// every rule and reports all bad ones at once. Any failure returns no engine.
func LoadSigned(path string, pub ed25519.PublicKey) (*Engine, error) {
	data, err := packs.ReadFileSigned(path, pub)
	if err != nil {
		return nil, fmt.Errorf("policy: %w", err)
	}
	e, err := Parse(data)
	if err != nil {
		return nil, err
	}
	if e.expires == nil {
		return nil, fmt.Errorf("policy: %s: a signed policy needs expires_at", path)
	}
	if e.Expired(time.Now()) {
		return nil, fmt.Errorf("policy: %s: signed policy has expired", path)
	}
	return e, nil
}
