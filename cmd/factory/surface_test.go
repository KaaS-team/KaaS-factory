package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/pkg/sandbox"
	"gopkg.in/yaml.v3"
)

// TestBrowserPackCommandParses: the command line the browser pack runs parses against the mounted command.
func TestBrowserPackCommandParses(t *testing.T) {
	data, err := os.ReadFile("../../packs/checks/browser/pack.yaml")
	if err != nil {
		t.Fatal(err)
	}
	var p struct {
		Command string `yaml:"command"`
	}
	if err := yaml.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(p.Command)
	if len(f) < 2 || f[0] != "factory" {
		t.Fatalf("pack command %q does not start with factory", p.Command)
	}
	stdout, _, err := runCLI(t, append(f[1:], "--help")...)
	if err != nil {
		t.Fatalf("%q: %v", p.Command, err)
	}
	if !strings.Contains(stdout, "FACTORY_GATES") {
		t.Errorf("help does not describe the gate line:\n%s", stdout)
	}
}

// TestA2ARefusesWithoutToken: the mounted a2a command refuses to start with no bearer token.
func TestA2ARefusesWithoutToken(t *testing.T) {
	t.Setenv("FACTORY_A2A_TOKEN", "")
	_, _, err := runCLI(t, "a2a", "--addr", "127.0.0.1:0")
	if err == nil || !strings.Contains(err.Error(), "FACTORY_A2A_TOKEN") {
		t.Fatalf("got %v", err)
	}
}

// TestA2ADeps_NeedsGitHub: only the github tracker can file tickets for a2a.
func TestA2ADeps_NeedsGitHub(t *testing.T) {
	_, err := a2aDepsFor(config.Config{Tracker: "linear"})
	if err == nil || !strings.Contains(err.Error(), "tracker github") {
		t.Fatalf("got %v", err)
	}
}

// TestMain lets this test binary be the jail helper: with a sandbox request in the environment it
// runs main, whose first call must hand over to the real program.
func TestMain(m *testing.M) {
	if _, ok := os.LookupEnv("KAAS_SANDBOX_HELPER"); ok {
		main()
		return
	}
	os.Exit(m.Run())
}

// TestMainEntersTheSandboxHelper: a command built by sandbox.Command, run through main, execs the
// requested program with only the spec's environment.
func TestMainEntersTheSandboxHelper(t *testing.T) {
	dir := t.TempDir()
	cmd, err := sandbox.Command(t.Context(), sandbox.Spec{Workdir: dir, ReadOnly: []string{"/"}, ReadWrite: []string{dir}, AllowNet: true,
		Env: []string{"WHO=jail"}}, "sh", "-c", "echo $WHO")
	if err != nil {
		t.Fatal(err)
	}
	out, err := cmd.Output()
	if err != nil || strings.TrimSpace(string(out)) != "jail" {
		t.Fatalf("out %q err %v", out, err)
	}
}

// TestCanJail: sandbox: true wraps only where the host can enforce a jail.
func TestCanJail(t *testing.T) {
	for _, tc := range []struct {
		name string
		c    sandbox.Capabilities
		want bool
	}{
		{"none", sandbox.Capabilities{Rlimits: true}, false},
		{"landlock", sandbox.Capabilities{Landlock: true}, true},
		{"sandbox-exec", sandbox.Capabilities{SandboxExec: true}, true},
	} {
		if got := canJail(tc.c); got != tc.want {
			t.Errorf("%s: got %v", tc.name, got)
		}
	}
}

// TestUpgradeMounts: `upgrade` is the self-update and pack bumps live under `packs upgrade`.
func TestUpgradeMounts(t *testing.T) {
	out, _, err := runCLI(t, "upgrade", "--help")
	if err != nil || !strings.Contains(out, "--check") {
		t.Fatalf("upgrade --help: %v\n%s", err, out)
	}
	if out, _, err := runCLI(t, "packs", "upgrade", "--help"); err != nil || !strings.Contains(out, "--baseline") {
		t.Fatalf("packs upgrade --help: %v\n%s", err, out)
	}
}

func appKeyPEM(t *testing.T) []byte {
	t.Helper()
	k, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	return pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(k)})
}

// TestGitHubAuth: app keys mint an installation token; without them GITHUB_TOKEN is used as before.
func TestGitHubAuth(t *testing.T) {
	var seen []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = append(seen, r.Method+" "+r.URL.Path+" "+r.Header.Get("Authorization")[:7])
		if r.URL.Path == "/app/installations/9/access_tokens" {
			w.WriteHeader(http.StatusCreated)
			_, _ = w.Write([]byte(`{"token":"inst-token","expires_at":"` + time.Now().Add(time.Hour).UTC().Format(time.RFC3339) + `"}`))
			return
		}
		if got := r.Header.Get("Authorization"); got != "Bearer inst-token" && got != "Bearer env-token" {
			t.Errorf("authorization %q", got)
		}
	}))
	defer srv.Close()
	t.Setenv("GITHUB_API_URL", srv.URL)
	keyFile := filepath.Join(t.TempDir(), "app.pem")
	if err := os.WriteFile(keyFile, appKeyPEM(t), 0o600); err != nil {
		t.Fatal(err)
	}

	t.Run("app", func(t *testing.T) {
		t.Setenv("GITHUB_TOKEN", "")
		g, err := newGitHubConn(config.Config{Repo: "a/b", GitHubApp: config.GitHubApp{ID: 1, InstallationID: 9, KeyFile: keyFile}})
		if err != nil {
			t.Fatal(err)
		}
		resp, err := g.http.Get(srv.URL + "/repos/a/b")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if len(seen) != 2 || !strings.HasPrefix(seen[0], "POST /app/installations/9/access_tokens Bearer") {
			t.Fatalf("requests: %v", seen)
		}
	})
	t.Run("token without app keys", func(t *testing.T) {
		t.Setenv("GITHUB_TOKEN", "env-token")
		g, err := newGitHubConn(config.Config{Repo: "a/b"})
		if err != nil {
			t.Fatal(err)
		}
		resp, err := g.http.Get(srv.URL + "/repos/a/b")
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
	})
	for name, tc := range map[string]struct {
		app  config.GitHubApp
		want string
	}{
		"no installation":  {config.GitHubApp{ID: 1, KeyFile: keyFile}, "installation_id"},
		"missing key file": {config.GitHubApp{ID: 1, InstallationID: 9, KeyFile: keyFile + ".none"}, "app private key"},
		"no key at all":    {config.GitHubApp{ID: 1, InstallationID: 9}, "GITHUB_APP_PRIVATE_KEY"},
	} {
		t.Run(name, func(t *testing.T) {
			t.Setenv("GITHUB_APP_PRIVATE_KEY", "")
			_, err := newGitHubConn(config.Config{Repo: "a/b", GitHubApp: tc.app})
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("got %v, want %q", err, tc.want)
			}
		})
	}
}
