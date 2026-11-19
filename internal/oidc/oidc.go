// Package oidc checks OIDC bearer tokens from an outside identity provider (Zitadel, Keycloak, Okta,
// Entra) and maps the token's groups claim to a factory role. Discovery, the JWKS fetch and its cache,
// and the iss, aud, exp and nbf checks are done by github.com/coreos/go-oidc (Apache-2.0).
package oidc

import (
	"context"
	"errors"
	"net/http"
	"strings"

	gooidc "github.com/coreos/go-oidc/v3/oidc"
)

// Config names the identity provider and the audience this service accepts.
type Config struct {
	Issuer      string // FACTORY_OIDC_ISSUER
	Audience    string // FACTORY_OIDC_AUDIENCE
	GroupsClaim string // defaults to "groups"
	Roles       Roles  // defaults to DefaultRoles
}

// Roles maps a group name to a role. The first role in Order that the caller holds wins.
type Roles struct {
	Groups map[string]string
	Order  []string // roles from most to least privileged
}

// DefaultRoles is the small table used when Config.Roles is empty.
var DefaultRoles = Roles{
	Groups: map[string]string{"factory-admins": "admin", "factory-operators": "operator", "factory-viewers": "viewer"},
	Order:  []string{"admin", "operator", "viewer"},
}

// Role returns the most privileged role the groups grant, or "" when none does.
func (r Roles) Role(groups []string) string {
	have := map[string]bool{}
	for _, g := range groups {
		if role, ok := r.Groups[g]; ok {
			have[role] = true
		}
	}
	for _, role := range r.Order {
		if have[role] {
			return role
		}
	}
	return ""
}

// Identity is who a valid token says the caller is.
type Identity struct {
	Subject string
	Groups  []string
	Role    string
}

// Verifier checks bearer tokens against one issuer.
type Verifier struct {
	v     *gooidc.IDTokenVerifier
	claim string
	roles Roles
}

// New discovers the issuer and returns a Verifier. Keys are fetched on first use and cached by go-oidc.
func New(ctx context.Context, c Config) (*Verifier, error) {
	if c.Issuer == "" || c.Audience == "" {
		return nil, errors.New("oidc: issuer and audience are required")
	}
	p, err := gooidc.NewProvider(ctx, c.Issuer)
	if err != nil {
		return nil, err
	}
	if c.GroupsClaim == "" {
		c.GroupsClaim = "groups"
	}
	if len(c.Roles.Groups) == 0 {
		c.Roles = DefaultRoles
	}
	return &Verifier{v: p.Verifier(&gooidc.Config{ClientID: c.Audience}), claim: c.GroupsClaim, roles: c.Roles}, nil
}

// Verify checks signature, iss, aud, exp and nbf, then maps the groups to a role.
func (v *Verifier) Verify(ctx context.Context, raw string) (Identity, error) {
	t, err := v.v.Verify(ctx, raw)
	if err != nil {
		return Identity{}, err
	}
	var claims map[string]any
	if err := t.Claims(&claims); err != nil {
		return Identity{}, err
	}
	var groups []string
	switch x := claims[v.claim].(type) {
	case []any:
		for _, e := range x {
			if s, ok := e.(string); ok {
				groups = append(groups, s)
			}
		}
	case string:
		groups = []string{x}
	}
	return Identity{Subject: t.Subject, Groups: groups, Role: v.roles.Role(groups)}, nil
}

type ctxKey struct{}

// From returns the identity Middleware stored on the request.
func From(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

// Middleware requires a valid bearer token. A missing or bad token is a 401; a valid token whose groups
// grant no role is a 403. Paths for which skip returns true pass through (for example /healthz).
func Middleware(v *Verifier, skip func(*http.Request) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if skip != nil && skip(r) {
				next.ServeHTTP(w, r)
				return
			}
			raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok || raw == "" {
				deny(w, http.StatusUnauthorized, "bearer token required")
				return
			}
			id, err := v.Verify(r.Context(), raw)
			if err != nil {
				deny(w, http.StatusUnauthorized, "invalid token")
				return
			}
			if id.Role == "" {
				deny(w, http.StatusForbidden, "no role for your groups")
				return
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), ctxKey{}, id)))
		})
	}
}

func deny(w http.ResponseWriter, code int, msg string) {
	if code == http.StatusUnauthorized {
		w.Header().Set("WWW-Authenticate", `Bearer realm="factory"`)
	}
	http.Error(w, msg, code)
}
