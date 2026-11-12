package githubauth

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func newKey(t *testing.T) (*rsa.PrivateKey, []byte) {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return k, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
}

var t0 = time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC)

func TestJWTClaimsAndSignature(t *testing.T) {
	k, pemBytes := newKey(t)
	a := &App{ID: 4242, PrivateKeyPEM: pemBytes, Now: func() time.Time { return t0 }}
	jwt, err := a.JWT()
	if err != nil {
		t.Fatal(err)
	}
	parts := strings.Split(jwt, ".")
	if len(parts) != 3 {
		t.Fatalf("parts = %d", len(parts))
	}
	sig, _ := base64.RawURLEncoding.DecodeString(parts[2])
	sum := sha256.Sum256([]byte(parts[0] + "." + parts[1]))
	if err := rsa.VerifyPKCS1v15(&k.PublicKey, crypto.SHA256, sum[:], sig); err != nil {
		t.Fatalf("signature does not verify: %v", err)
	}
	var claims struct {
		Iat, Exp int64
		Iss      string
	}
	raw, _ := base64.RawURLEncoding.DecodeString(parts[1])
	if err := json.Unmarshal(raw, &claims); err != nil {
		t.Fatal(err)
	}
	if claims.Iat != t0.Add(-60*time.Second).Unix() || claims.Exp != t0.Add(10*time.Minute).Unix() || claims.Iss != "4242" {
		t.Fatalf("claims = %+v", claims)
	}
	var hdr map[string]string
	raw, _ = base64.RawURLEncoding.DecodeString(parts[0])
	_ = json.Unmarshal(raw, &hdr)
	if hdr["alg"] != "RS256" {
		t.Fatalf("header = %v", hdr)
	}
}

func TestJWTBadKey(t *testing.T) {
	for name, key := range map[string]string{"not pem": "nope", "bad der": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("x")}))} {
		t.Run(name, func(t *testing.T) {
			if _, err := (&App{PrivateKeyPEM: []byte(key)}).JWT(); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestJWTPKCS8(t *testing.T) {
	k, _ := newKey(t)
	der, _ := x509.MarshalPKCS8PrivateKey(k)
	a := &App{ID: 1, PrivateKeyPEM: pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})}
	if _, err := a.JWT(); err != nil {
		t.Fatal(err)
	}
}

func TestTokenCacheRefreshWindow(t *testing.T) {
	_, pemBytes := newKey(t)
	var calls atomic.Int32
	now := t0
	expiry := t0.Add(time.Hour)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if r.URL.Path != "/app/installations/77/access_tokens" || r.Method != http.MethodPost || !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			t.Errorf("bad request %s %s", r.Method, r.URL.Path)
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(map[string]any{"token": "tok" + string('0'+n), "expires_at": expiry})
	}))
	defer srv.Close()
	a := &App{ID: 1, InstallationID: 77, PrivateKeyPEM: pemBytes, APIBase: srv.URL, Now: func() time.Time { return now }}
	rows := []struct {
		name  string
		at    time.Time
		want  string
		calls int32
	}{
		{"first call fetches", t0, "tok1", 1},
		{"cached well before window", t0.Add(54 * time.Minute), "tok1", 1},
		{"just outside window still cached", expiry.Add(-5*time.Minute - time.Second), "tok1", 1},
		{"inside window refreshes", expiry.Add(-5 * time.Minute), "tok2", 2},
	}
	for _, r := range rows {
		now = r.at
		got, err := a.Token(context.Background())
		if err != nil || got != r.want || calls.Load() != r.calls {
			t.Fatalf("%s: got %q err %v calls %d", r.name, got, err, calls.Load())
		}
		if r.name == "inside window refreshes" {
			expiry = now.Add(time.Hour)
		}
	}
}

func TestTokenErrors(t *testing.T) {
	_, pemBytes := newKey(t)
	for name, h := range map[string]http.HandlerFunc{
		"status": func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(401) },
		"junk":   func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(201); _, _ = w.Write([]byte("{")) },
	} {
		t.Run(name, func(t *testing.T) {
			srv := httptest.NewServer(h)
			defer srv.Close()
			a := &App{ID: 1, InstallationID: 1, PrivateKeyPEM: pemBytes, APIBase: srv.URL}
			if _, err := a.Token(context.Background()); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestKeySources(t *testing.T) {
	p := filepath.Join(t.TempDir(), "k.pem")
	if err := os.WriteFile(p, []byte("pem"), 0o600); err != nil {
		t.Fatal(err)
	}
	if b, err := KeyFromFile(p); err != nil || string(b) != "pem" {
		t.Fatal(b, err)
	}
	if _, err := KeyFromFile(p + ".missing"); err == nil {
		t.Fatal("want error")
	}
	t.Setenv("GHAPP_TEST_KEY", "envpem")
	if b, err := KeyFromEnv("GHAPP_TEST_KEY"); err != nil || string(b) != "envpem" {
		t.Fatal(b, err)
	}
	if _, err := KeyFromEnv("GHAPP_TEST_UNSET"); err == nil {
		t.Fatal("want error")
	}
}
