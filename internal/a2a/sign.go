package a2a

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/http"
	"os"

	"github.com/a2aproject/a2a-go/v2/a2acrypto"
)

// jwksPath is where the key set that verifies the signed card is served.
const jwksPath = "/.well-known/jwks.json"

// LoadKey reads an ECDSA P-256 private key from a PEM file (SEC 1 or PKCS 8).
func LoadKey(path string) (*ecdsa.PrivateKey, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	blk, _ := pem.Decode(raw)
	if blk == nil {
		return nil, fmt.Errorf("a2a: %s holds no PEM block", path)
	}
	if k, err := x509.ParseECPrivateKey(blk.Bytes); err == nil {
		return checkP256(k)
	}
	any, err := x509.ParsePKCS8PrivateKey(blk.Bytes)
	if err != nil {
		return nil, fmt.Errorf("a2a: %s is not an EC or PKCS 8 key: %w", path, err)
	}
	k, ok := any.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("a2a: %s is not an ECDSA key", path)
	}
	return checkP256(k)
}

func checkP256(k *ecdsa.PrivateKey) (*ecdsa.PrivateKey, error) {
	if k.Curve != elliptic.P256() {
		return nil, errors.New("a2a: the signing key must be ECDSA P-256")
	}
	return k, nil
}

// newSigning builds the card signer for key (a new key when nil) and the handler that serves its public half as a JWKS.
func newSigning(key *ecdsa.PrivateKey, jku string) (func(context.Context) ([]*a2acrypto.Signer, error), http.Handler, error) {
	if key == nil {
		var err error
		if key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader); err != nil {
			return nil, nil, err
		}
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return nil, nil, err
	}
	sum := sha256.Sum256(der)
	kid := hex.EncodeToString(sum[:8])
	signer, err := a2acrypto.NewSigner(a2acrypto.SignerConfig{PrivateKey: key, KeyID: kid, JWKSURL: jku})
	if err != nil {
		return nil, nil, err
	}
	pub, err := key.PublicKey.ECDH()
	if err != nil {
		return nil, nil, err
	}
	pt := pub.Bytes() // 0x04 || X || Y
	b64 := base64.RawURLEncoding.EncodeToString
	set, _ := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "EC", "crv": "P-256", "alg": "ES256", "use": "sig", "kid": kid,
		"x": b64(pt[1:33]), "y": b64(pt[33:]),
	}}})
	return func(context.Context) ([]*a2acrypto.Signer, error) { return []*a2acrypto.Signer{signer}, nil },
		http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(set)
		}), nil
}
