package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
)

// loopCore is a Control that owns a run loop, the shape `factory serve` needs.
type loopCore struct{ *fakeControl }

func (loopCore) Run(ctx context.Context) error { <-ctx.Done(); return nil }

// TestServeRefusesNonLoopbackWithoutPassword: an exposed listener needs a password.
func TestServeRefusesNonLoopbackWithoutPassword(t *testing.T) {
	t.Setenv(servePasswordEnv, "")
	_, _, err := runCLI(t, "serve", "--addr", "0.0.0.0:0")
	if err == nil || !strings.Contains(err.Error(), servePasswordEnv) || !strings.Contains(err.Error(), "loopback") {
		t.Fatalf("got %v", err)
	}
}

// TestServeTokenNeedsPassword: the token command refuses to sign with no password.
func TestServeTokenNeedsPassword(t *testing.T) {
	t.Setenv(servePasswordEnv, "")
	if _, _, err := runCLI(t, "serve", "token"); err == nil || !strings.Contains(err.Error(), servePasswordEnv) {
		t.Fatalf("got %v", err)
	}
}

// TestServeGuardsRoutesWithThePassword: with the password set, the running listener answers 401 to
// a request with no credential, accepts the password and a token from `serve token`, and leaves
// /healthz open for probes.
func TestServeGuardsRoutesWithThePassword(t *testing.T) {
	t.Setenv(servePasswordEnv, "hunter2")
	token, _, err := runCLI(t, "serve", "token")
	if err != nil {
		t.Fatal(err)
	}
	token = strings.TrimSpace(token)
	use(t, &fakeControl{})
	old := newControl
	newControl = func(c config.Config) (api.Control, error) { return loopCore{&fakeControl{}}, nil }
	t.Cleanup(func() { newControl = old })

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()

	ctx, cancel := context.WithCancel(t.Context())
	root := newRoot()
	root.SetArgs([]string{"serve", "--addr", addr, "--drain", "1s"})
	done := make(chan error, 1)
	go func() {
		done <- root.ExecuteContext(ctx)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	})

	get := func(path, bearer string) int {
		for range 100 {
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+path, nil)
			if bearer != "" {
				req.Header.Set("Authorization", "Bearer "+bearer)
			}
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				_ = resp.Body.Close()
				return resp.StatusCode
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("serve never listened")
		return 0
	}
	if got := get("/jobs/x/runs", ""); got != http.StatusUnauthorized {
		t.Errorf("no credential: %d, want 401", got)
	}
	for name, cred := range map[string]string{"password": "hunter2", "token": token} {
		if got := get("/jobs/x/runs", cred); got == http.StatusUnauthorized {
			t.Errorf("%s was refused", name)
		}
	}
	if got := get("/healthz", ""); got == http.StatusUnauthorized {
		t.Error("/healthz needs no credential")
	}
}

// fakeIssuer is an OIDC provider with discovery and an empty key set: every token fails to verify.
func fakeIssuer(t *testing.T) string {
	t.Helper()
	var url string
	mux := http.NewServeMux()
	mux.HandleFunc("/.well-known/openid-configuration", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"issuer":"` + url + `","jwks_uri":"` + url + `/keys","authorization_endpoint":"` + url + `/a","token_endpoint":"` + url + `/t","id_token_signing_alg_values_supported":["RS256"]}`))
	})
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(`{"keys":[]}`)) })
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	url = srv.URL
	return url
}

// TestServeOIDCRejectsBadToken: with FACTORY_OIDC_ISSUER set, a bad bearer is 401 even when the
// shared password is set too, and /healthz stays open.
func TestServeOIDCRejectsBadToken(t *testing.T) {
	t.Setenv(servePasswordEnv, "hunter2")
	t.Setenv("FACTORY_OIDC_ISSUER", fakeIssuer(t))
	use(t, &fakeControl{})
	old := newControl
	newControl = func(config.Config) (api.Control, error) { return loopCore{&fakeControl{}}, nil }
	t.Cleanup(func() { newControl = old })
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	ctx, cancel := context.WithCancel(t.Context())
	root := newRoot()
	root.SetArgs([]string{"serve", "--addr", addr, "--drain", "1s"})
	done := make(chan error, 1)
	go func() { done <- root.ExecuteContext(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	})
	get := func(path, bearer string) int {
		for range 100 {
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+addr+path, nil)
			if bearer != "" {
				req.Header.Set("Authorization", "Bearer "+bearer)
			}
			resp, err := http.DefaultClient.Do(req)
			if err == nil {
				_ = resp.Body.Close()
				return resp.StatusCode
			}
			time.Sleep(20 * time.Millisecond)
		}
		t.Fatal("serve never listened")
		return 0
	}
	if got := get("/jobs/x/runs", "not-a-jwt"); got != http.StatusUnauthorized {
		t.Errorf("bad token: %d, want 401", got)
	}
	if got := get("/jobs/x/runs", "hunter2"); got != http.StatusUnauthorized {
		t.Errorf("the password must not pass when OIDC is on: %d", got)
	}
	if got := get("/healthz", ""); got == http.StatusUnauthorized {
		t.Error("/healthz needs no credential")
	}
}
