package oidc

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
	"github.com/go-jose/go-jose/v4/jwt"
)

type idp struct {
	srv *httptest.Server
	key *rsa.PrivateKey
}

func newIdP(t *testing.T) *idp {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{key: k}
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"issuer": p.srv.URL, "jwks_uri": p.srv.URL + "/jwks",
			"authorization_endpoint": p.srv.URL + "/a", "token_endpoint": p.srv.URL + "/t",
			"id_token_signing_alg_values_supported": []string{"RS256"}})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		e := base64.RawURLEncoding.EncodeToString(big.NewInt(int64(k.E)).Bytes())
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{"kty": "RSA", "alg": "RS256", "use": "sig",
			"kid": "k1", "n": base64.RawURLEncoding.EncodeToString(k.N.Bytes()), "e": e}}})
	})
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	return p
}

func (p *idp) token(t *testing.T, kid, aud string, exp, nbf time.Time, groups ...string) string {
	t.Helper()
	s, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: p.key},
		(&jose.SignerOptions{}).WithType("JWT").WithHeader("kid", kid))
	if err != nil {
		t.Fatal(err)
	}
	c := jwt.Claims{Issuer: p.srv.URL, Subject: "u1", Audience: jwt.Audience{aud}, Expiry: jwt.NewNumericDate(exp), NotBefore: jwt.NewNumericDate(nbf)}
	raw, err := jwt.Signed(s).Claims(c).Claims(map[string]any{"groups": groups}).Serialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func call(t *testing.T, h http.Handler, tok string) int {
	t.Helper()
	r := httptest.NewRequest("GET", "/x", nil)
	if tok != "" {
		r.Header.Set("Authorization", "Bearer "+tok)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w.Code
}

func TestMiddleware(t *testing.T) {
	p := newIdP(t)
	v, err := New(context.Background(), Config{Issuer: p.srv.URL, Audience: "factory"})
	if err != nil {
		t.Fatal(err)
	}
	var got Identity
	h := Middleware(v, nil)(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got, _ = From(r.Context()) }))
	now := time.Now()
	ok, past, future := now.Add(time.Hour), now.Add(-time.Hour), now.Add(time.Hour)
	tests := []struct {
		name string
		tok  string
		want int
	}{
		{"valid", p.token(t, "k1", "factory", ok, past, "factory-operators", "other"), 200},
		{"wrong aud", p.token(t, "k1", "someone-else", ok, past, "factory-admins"), 401},
		{"expired", p.token(t, "k1", "factory", past, past.Add(-time.Hour), "factory-admins"), 401},
		{"not yet valid", p.token(t, "k1", "factory", future.Add(time.Hour), future, "factory-admins"), 401},
		{"unknown kid", p.token(t, "nope", "factory", ok, past, "factory-admins"), 401},
		{"no token", "", 401},
		{"no matching group", p.token(t, "k1", "factory", ok, past, "random"), 403},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if c := call(t, h, tc.tok); c != tc.want {
				t.Fatalf("status %d, want %d", c, tc.want)
			}
		})
	}
	if got.Role != "operator" || got.Subject != "u1" {
		t.Fatalf("identity %+v, want operator u1", got)
	}
}

func TestRoleOrder(t *testing.T) {
	if r := DefaultRoles.Role([]string{"factory-viewers", "factory-admins"}); r != "admin" {
		t.Fatalf("got %q, want admin", r)
	}
}
