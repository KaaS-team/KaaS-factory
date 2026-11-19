package serve

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// No issuer: the password wrap is returned untouched, and an unreachable issuer is an error, not a bypass.
func TestAuthWrap_NoIssuerKeepsPassword(t *testing.T) {
	called := false
	pw := func(h http.Handler) http.Handler {
		called = true
		return h
	}
	w, err := AuthWrap(context.Background(), func(string) string { return "" }, pw)
	if err != nil {
		t.Fatal(err)
	}
	w(http.NotFoundHandler())
	if !called {
		t.Fatal("password wrap was not used")
	}
}

func TestAuthWrap_IssuerRequiresBearer(t *testing.T) {
	idp := httptest.NewServer(http.NotFoundHandler())
	defer idp.Close()
	_, err := AuthWrap(context.Background(), func(k string) string {
		if k == EnvOIDCIssuer {
			return idp.URL
		}
		return ""
	}, nil)
	if err == nil {
		t.Fatal("want a discovery error for a dead issuer")
	}
}
