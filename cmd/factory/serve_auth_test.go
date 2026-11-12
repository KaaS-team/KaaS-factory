package main

import (
	"context"
	"net"
	"net/http"
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
