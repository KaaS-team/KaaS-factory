//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

// Package sso signs people in through the company IdP with OIDC (authorization code with PKCE).
// The IdP proves who someone is; the caller decides what a session may do. SAML is not supported.
package sso

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

const (
	flowCookie = "factory_oidc"
	flowTTL    = 600
)

// Session is who the IdP says signed in: a lower-case verified email and the groups claim.
type Session struct {
	Email  string
	Groups []string
}

// OIDCConfig names the IdP and the client registered with it. OnSession receives each successful
// sign-in and is responsible for starting the caller's own session. GroupsClaim defaults to "groups".
type OIDCConfig struct {
	Issuer       string
	ClientID     string
	ClientSecret string
	RedirectURL  string
	GroupsClaim  string
	OnSession    func(http.ResponseWriter, *http.Request, Session)
}

// OIDC serves the two legs of the sign-in: Login redirects to the IdP and Callback finishes it.
type OIDC struct {
	cfg      OIDCConfig
	oauth    oauth2.Config
	verifier *oidc.IDTokenVerifier
}

// NewOIDC discovers the issuer's endpoints and returns a ready flow. Discovery fails if the
// document names a different issuer.
func NewOIDC(ctx context.Context, cfg OIDCConfig) (*OIDC, error) {
	if cfg.Issuer == "" || cfg.ClientID == "" || cfg.ClientSecret == "" || cfg.RedirectURL == "" {
		return nil, errors.New("sso: issuer, client id, client secret and redirect url are required")
	}
	if cfg.OnSession == nil {
		return nil, errors.New("sso: OnSession is required")
	}
	if cfg.GroupsClaim == "" {
		cfg.GroupsClaim = "groups"
	}
	prov, err := oidc.NewProvider(ctx, cfg.Issuer)
	if err != nil {
		return nil, err
	}
	return &OIDC{
		cfg: cfg,
		oauth: oauth2.Config{
			ClientID: cfg.ClientID, ClientSecret: cfg.ClientSecret, RedirectURL: cfg.RedirectURL,
			Endpoint: prov.Endpoint(), Scopes: []string{oidc.ScopeOpenID, "email", "profile"},
		},
		// go-oidc checks signature, issuer, audience and expiry; only RS256 is accepted.
		verifier: prov.Verifier(&oidc.Config{ClientID: cfg.ClientID, SupportedSigningAlgs: []string{oidc.RS256}}),
	}, nil
}

func random(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

func setFlow(w http.ResponseWriter, r *http.Request, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name: flowCookie, Value: value, Path: "/", MaxAge: maxAge, HttpOnly: true,
		Secure: r.TLS != nil || r.Header.Get("X-Forwarded-Proto") == "https", SameSite: http.SameSiteLaxMode,
	})
}

// Login redirects to the IdP with a fresh state, nonce and PKCE challenge, kept in a short cookie.
func (o *OIDC) Login(w http.ResponseWriter, r *http.Request) {
	state, nonce, verifier := random(16), random(16), random(32)
	sum := sha256.Sum256([]byte(verifier))
	url := o.oauth.AuthCodeURL(state,
		oidc.Nonce(nonce),
		oauth2.SetAuthURLParam("code_challenge", base64.RawURLEncoding.EncodeToString(sum[:])),
		oauth2.SetAuthURLParam("code_challenge_method", "S256"))
	setFlow(w, r, state+"."+nonce+"."+verifier, flowTTL)
	http.Redirect(w, r, url, http.StatusFound)
}

// Callback exchanges the code, verifies the ID token against the nonce, and hands the session to
// OnSession. A bad state is a 400; anything the IdP or the token gets wrong is a 401.
func (o *OIDC) Callback(w http.ResponseWriter, r *http.Request) {
	c, err := r.Cookie(flowCookie)
	parts := []string{}
	if err == nil {
		parts = strings.Split(c.Value, ".")
	}
	if len(parts) != 3 || subtle.ConstantTimeCompare([]byte(r.URL.Query().Get("state")), []byte(parts[0])) != 1 {
		http.Error(w, "sign-in expired, start again", http.StatusBadRequest)
		return
	}
	setFlow(w, r, "", -1)
	s, err := o.finish(r, parts[1], parts[2])
	if err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	o.cfg.OnSession(w, r, s)
}

func (o *OIDC) finish(r *http.Request, nonce, verifier string) (Session, error) {
	tok, err := o.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.SetAuthURLParam("code_verifier", verifier))
	if err != nil {
		return Session{}, errors.New("the IdP refused the sign-in code")
	}
	raw, _ := tok.Extra("id_token").(string)
	id, err := o.verifier.Verify(r.Context(), raw)
	if err != nil {
		return Session{}, errors.New("the ID token is not valid")
	}
	if id.Nonce != nonce {
		return Session{}, errors.New("the token answers another sign-in")
	}
	var claims map[string]any
	if err := id.Claims(&claims); err != nil {
		return Session{}, errors.New("the ID token has unreadable claims")
	}
	email, _ := claims["email"].(string)
	if verified, ok := claims["email_verified"].(bool); email == "" || (ok && !verified) {
		return Session{}, errors.New("the IdP did not vouch for an email address")
	}
	return Session{Email: strings.ToLower(strings.TrimSpace(email)), Groups: stringList(claims[o.cfg.GroupsClaim])}, nil
}

func stringList(v any) []string {
	out := []string{}
	switch x := v.(type) {
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok {
				out = append(out, s)
			}
		}
	case string:
		out = append(out, x)
	}
	return out
}
