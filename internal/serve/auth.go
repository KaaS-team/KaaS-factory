package serve

import (
	"context"
	"net/http"

	"github.com/KaaS-team/factory/internal/oidc"
)

// Environment names for OIDC sign-in.
const (
	EnvOIDCIssuer   = "FACTORY_OIDC_ISSUER"
	EnvOIDCAudience = "FACTORY_OIDC_AUDIENCE"
)

// AuthWrap picks the guard for the routes. With no FACTORY_OIDC_ISSUER it returns password unchanged, so
// the shared password path stays the default. With an issuer it returns the OIDC bearer middleware;
// /healthz and /readyz stay open. The audience defaults to "factory".
func AuthWrap(ctx context.Context, getenv func(string) string, password func(http.Handler) http.Handler) (func(http.Handler) http.Handler, error) {
	iss := getenv(EnvOIDCIssuer)
	if iss == "" {
		return password, nil
	}
	aud := getenv(EnvOIDCAudience)
	if aud == "" {
		aud = "factory"
	}
	v, err := oidc.New(ctx, oidc.Config{Issuer: iss, Audience: aud})
	if err != nil {
		return nil, err
	}
	return oidc.Middleware(v, func(r *http.Request) bool { return r.URL.Path == "/healthz" || r.URL.Path == "/readyz" }), nil
}
