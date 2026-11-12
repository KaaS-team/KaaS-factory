//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package sso_test

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/ee/sso"
)

type idp struct {
	srv    *httptest.Server
	key    *rsa.PrivateKey
	claims func(nonce string) map[string]any
	// nonce and challenge are what the authorize request carried; the token step answers them.
	nonce, challenge string
	// forged, when set, is served as the ID token in place of a signed one.
	forged string
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func (p *idp) sign(t *testing.T, header, claims map[string]any) string {
	t.Helper()
	h, _ := json.Marshal(header)
	c, _ := json.Marshal(claims)
	in := b64(h) + "." + b64(c)
	sum := sha256.Sum256([]byte(in))
	sig, err := rsa.SignPKCS1v15(rand.Reader, p.key, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatal(err)
	}
	return in + "." + b64(sig)
}

func newIDP(t *testing.T) *idp {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	p := &idp{key: key}
	mux := http.NewServeMux()
	p.srv = httptest.NewServer(mux)
	t.Cleanup(p.srv.Close)
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"issuer": p.srv.URL, "authorization_endpoint": p.srv.URL + "/authorize",
			"token_endpoint": p.srv.URL + "/token", "jwks_uri": p.srv.URL + "/jwks",
			"id_token_signing_alg_values_supported": []string{"RS256"},
		})
	})
	mux.HandleFunc("/jwks", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]any{{
			"kty": "RSA", "kid": "k1", "alg": "RS256", "use": "sig",
			"n": b64(key.N.Bytes()), "e": b64(big.NewInt(int64(key.E)).Bytes()),
		}}})
	})
	mux.HandleFunc("/token", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		sum := sha256.Sum256([]byte(r.Form.Get("code_verifier")))
		if r.Form.Get("code") != "good-code" || b64(sum[:]) != p.challenge {
			http.Error(w, `{"error":"invalid_grant"}`, 400)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		tok := p.forged
		if tok == "" {
			tok = p.sign(t, map[string]any{"alg": "RS256", "kid": "k1"}, p.claims(p.nonce))
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "at", "token_type": "Bearer", "id_token": tok})
	})
	return p
}

const (
	clientID = "factory"
	redirect = "https://factory.example/auth/oidc/callback"
)

func good(p *idp, over map[string]any) func(string) map[string]any {
	return func(nonce string) map[string]any {
		c := map[string]any{
			"iss": p.srv.URL, "aud": clientID, "sub": "u1", "nonce": nonce,
			"iat": time.Now().Unix(), "exp": time.Now().Add(time.Hour).Unix(),
			"email": "Bo@Acme.example", "email_verified": true, "groups": []string{"eng", "release"},
		}
		for k, v := range over {
			if v == nil {
				delete(c, k)
			} else {
				c[k] = v
			}
		}
		return c
	}
}

type got struct {
	called  bool
	session sso.Session
}

func setup(t *testing.T, p *idp) (*sso.OIDC, *got) {
	t.Helper()
	g := &got{}
	o, err := sso.NewOIDC(context.Background(), sso.OIDCConfig{
		Issuer: p.srv.URL, ClientID: clientID, ClientSecret: "s3cret", RedirectURL: redirect,
		OnSession: func(_ http.ResponseWriter, _ *http.Request, s sso.Session) { g.called, g.session = true, s },
	})
	if err != nil {
		t.Fatal(err)
	}
	return o, g
}

// login runs the redirect step and returns the flow cookie and the state the IdP was given.
func login(t *testing.T, o *sso.OIDC, p *idp) (cookie *http.Cookie, state string) {
	t.Helper()
	w := httptest.NewRecorder()
	o.Login(w, httptest.NewRequest("GET", "/auth/oidc", nil))
	if w.Code != 302 {
		t.Fatalf("login status %d", w.Code)
	}
	loc, err := url.Parse(w.Header().Get("Location"))
	if err != nil || !strings.HasPrefix(loc.String(), p.srv.URL+"/authorize") {
		t.Fatalf("redirect %q", w.Header().Get("Location"))
	}
	q := loc.Query()
	if q.Get("response_type") != "code" || q.Get("client_id") != clientID || q.Get("redirect_uri") != redirect ||
		q.Get("code_challenge_method") != "S256" || !strings.Contains(q.Get("scope"), "openid") {
		t.Fatalf("authorize query %v", q)
	}
	p.nonce, p.challenge = q.Get("nonce"), q.Get("code_challenge")
	for _, c := range w.Result().Cookies() {
		if c.Name == "factory_oidc" {
			if !c.HttpOnly {
				t.Fatal("flow cookie is not HttpOnly")
			}
			return c, q.Get("state")
		}
	}
	t.Fatal("no flow cookie")
	return nil, ""
}

func callback(o *sso.OIDC, c *http.Cookie, state, code string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("GET", "/auth/oidc/callback?code="+code+"&state="+url.QueryEscape(state), nil)
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	o.Callback(w, r)
	return w
}

func TestLoginAndCallbackYieldSession(t *testing.T) {
	p := newIDP(t)
	p.claims = func(n string) map[string]any { return good(p, nil)(n) }
	o, g := setup(t, p)
	c, state := login(t, o, p)
	w := callback(o, c, state, "good-code")
	if !g.called {
		t.Fatalf("no session, status %d body %s", w.Code, w.Body)
	}
	if g.session.Email != "bo@acme.example" || strings.Join(g.session.Groups, ",") != "eng,release" {
		t.Fatalf("session %+v", g.session)
	}
	for _, ck := range w.Result().Cookies() {
		if ck.Name == "factory_oidc" && ck.MaxAge >= 0 {
			t.Fatal("flow cookie not cleared")
		}
	}
}

func TestCallbackRefusals(t *testing.T) {
	for name, tc := range map[string]struct {
		over       map[string]any
		code       string
		badState   bool
		noCookie   bool
		wantStatus int
	}{
		"wrong audience":   {over: map[string]any{"aud": "someone-else"}, code: "good-code", wantStatus: 401},
		"stale nonce":      {over: map[string]any{"nonce": "replayed"}, code: "good-code", wantStatus: 401},
		"expired":          {over: map[string]any{"exp": 1}, code: "good-code", wantStatus: 401},
		"wrong issuer":     {over: map[string]any{"iss": "https://evil.example"}, code: "good-code", wantStatus: 401},
		"no email":         {over: map[string]any{"email": nil}, code: "good-code", wantStatus: 401},
		"unverified email": {over: map[string]any{"email_verified": false}, code: "good-code", wantStatus: 401},
		"bad code":         {code: "bad-code", wantStatus: 401},
		"state mismatch":   {code: "good-code", badState: true, wantStatus: 400},
		"no flow cookie":   {code: "good-code", noCookie: true, wantStatus: 400},
	} {
		t.Run(name, func(t *testing.T) {
			p := newIDP(t)
			p.claims = func(n string) map[string]any { return good(p, tc.over)(n) }
			o, g := setup(t, p)
			c, state := login(t, o, p)
			if tc.badState {
				state = "forged"
			}
			if tc.noCookie {
				c = nil
			}
			w := callback(o, c, state, tc.code)
			if w.Code != tc.wantStatus || g.called {
				t.Fatalf("status %d called=%v body %s", w.Code, g.called, w.Body)
			}
		})
	}
}

func TestAlgNoneRefused(t *testing.T) {
	p := newIDP(t)
	o, g := setup(t, p)
	p.claims = func(n string) map[string]any { return good(p, nil)(n) }
	c, state := login(t, o, p)
	// An unsigned token: replace the signed one by serving alg none from a second token endpoint answer.
	forged := p.sign(t, map[string]any{"alg": "none"}, good(p, nil)(p.nonce))
	forged = forged[:strings.LastIndex(forged, ".")+1]
	p.claims = nil
	p.forged = forged
	if w := callback(o, c, state, "good-code"); w.Code != 401 || g.called {
		t.Fatalf("status %d called=%v", w.Code, g.called)
	}
}

func TestNewOIDCValidates(t *testing.T) {
	for name, cfg := range map[string]sso.OIDCConfig{
		"no issuer":   {ClientID: "a", ClientSecret: "b", RedirectURL: redirect},
		"no client":   {Issuer: "https://x", ClientSecret: "b", RedirectURL: redirect},
		"no secret":   {Issuer: "https://x", ClientID: "a", RedirectURL: redirect},
		"no redirect": {Issuer: "https://x", ClientID: "a", ClientSecret: "b"},
	} {
		t.Run(name, func(t *testing.T) {
			cfg.OnSession = func(http.ResponseWriter, *http.Request, sso.Session) {}
			if _, err := sso.NewOIDC(context.Background(), cfg); err == nil {
				t.Fatal("expected an error")
			}
		})
	}
	if _, err := sso.NewOIDC(context.Background(), sso.OIDCConfig{Issuer: "https://x", ClientID: "a", ClientSecret: "b", RedirectURL: redirect}); err == nil {
		t.Fatal("OnSession is required")
	}
}
