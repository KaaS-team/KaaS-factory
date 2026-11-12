// Package githubauth mints GitHub App installation tokens so an organization
// can run the factory as an app instead of a person.
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
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	defaultAPIBase = "https://api.github.com"
	refreshWindow  = 5 * time.Minute
	jwtBackdate    = 60 * time.Second
	jwtLifetime    = 10 * time.Minute
	maxResponse    = 1 << 20
)

// App holds the credentials of one GitHub App installation and caches its token.
type App struct {
	ID             int64
	PrivateKeyPEM  []byte
	InstallationID int64

	// APIBase overrides https://api.github.com; tests point it at a local server.
	APIBase string
	// Client overrides http.DefaultClient.
	Client *http.Client
	// Now overrides time.Now; tests use a fake clock.
	Now func() time.Time

	mu      sync.Mutex
	token   string
	expires time.Time
}

// KeyFromFile reads a PEM private key from a file path.
func KeyFromFile(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read app private key: %w", err)
	}
	return b, nil
}

// KeyFromEnv reads a PEM private key from the environment variable called name.
// The argument is the variable name, never the key itself.
func KeyFromEnv(name string) ([]byte, error) {
	v := os.Getenv(name)
	if v == "" {
		return nil, fmt.Errorf("environment variable %s is empty", name)
	}
	return []byte(v), nil
}

func (a *App) now() time.Time {
	if a.Now != nil {
		return a.Now()
	}
	return time.Now()
}

// JWT returns an RS256 app JWT: iat 60 seconds back, exp 10 minutes ahead, iss the app id.
func (a *App) JWT() (string, error) {
	key, err := parseKey(a.PrivateKeyPEM)
	if err != nil {
		return "", err
	}
	now := a.now()
	header, _ := json.Marshal(map[string]string{"alg": "RS256", "typ": "JWT"})
	claims, _ := json.Marshal(map[string]any{
		"iat": now.Add(-jwtBackdate).Unix(),
		"exp": now.Add(jwtLifetime).Unix(),
		"iss": fmt.Sprint(a.ID),
	})
	enc := base64.RawURLEncoding
	signing := enc.EncodeToString(header) + "." + enc.EncodeToString(claims)
	sum := sha256.Sum256([]byte(signing))
	sig, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, sum[:])
	if err != nil {
		return "", fmt.Errorf("sign app jwt: %w", err)
	}
	return signing + "." + enc.EncodeToString(sig), nil
}

func parseKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, errors.New("app private key is not PEM")
	}
	if k, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return k, nil
	}
	k, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, errors.New("app private key is neither PKCS1 nor PKCS8")
	}
	rk, ok := k.(*rsa.PrivateKey)
	if !ok {
		return nil, errors.New("app private key is not RSA")
	}
	return rk, nil
}

// Token returns the installation token, requesting a new one only when none is
// cached or the cached one expires within five minutes.
func (a *App) Token(ctx context.Context) (string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.token != "" && a.now().Add(refreshWindow).Before(a.expires) {
		return a.token, nil
	}
	jwt, err := a.JWT()
	if err != nil {
		return "", err
	}
	base := a.APIBase
	if base == "" {
		base = defaultAPIBase
	}
	url := fmt.Sprintf("%s/app/installations/%d/access_tokens", strings.TrimRight(base, "/"), a.InstallationID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+jwt)
	req.Header.Set("Accept", "application/vnd.github+json")
	client := a.Client
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("request installation token: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponse))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("installation token request returned %s", resp.Status)
	}
	var out struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	if err := json.Unmarshal(body, &out); err != nil || out.Token == "" {
		return "", errors.New("installation token response is malformed")
	}
	a.token, a.expires = out.Token, out.ExpiresAt
	return a.token, nil
}
