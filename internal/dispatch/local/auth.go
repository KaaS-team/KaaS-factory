// Ported from sst/opencode@a1aa513f78c7e9c57ea6c1237de09b702e18f934 packages/server/src/auth.ts
package local

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const sessionTTL = 30 * 24 * time.Hour

// Auth checks bearer credentials for the local dispatcher endpoint: the password, or a session token signed with a key derived from it.
type Auth struct {
	password string
	now      func() time.Time
}

// NewAuth returns an Auth for password; an empty password is an error.
func NewAuth(password string) (*Auth, error) {
	if password == "" {
		return nil, errors.New("local: auth password is empty")
	}
	return &Auth{password: password, now: time.Now}, nil
}

// Issue returns a session token valid for 30 days; a different password rejects it.
func (a *Auth) Issue() string {
	exp := strconv.FormatInt(a.now().Add(sessionTTL).Unix(), 10)
	return exp + "." + a.sign(exp)
}

// Middleware answers 401 unless the Authorization header carries the password or a valid session token as a Bearer credential. The query string is never read.
func (a *Auth) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cred, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		if !ok || (!eq(cred, a.password) && !a.verify(cred)) {
			w.Header().Set("WWW-Authenticate", "Bearer")
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (a *Auth) verify(token string) bool {
	exp, sig, ok := strings.Cut(token, ".")
	if !ok || strings.Contains(sig, ".") {
		return false
	}
	n, err := strconv.ParseInt(exp, 10, 64)
	return err == nil && n > a.now().Unix() && eq(sig, a.sign(exp))
}

func (a *Auth) sign(payload string) string {
	k := hmac.New(sha256.New, []byte(a.password))
	k.Write([]byte("kaas-session-v1"))
	m := hmac.New(sha256.New, k.Sum(nil))
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func eq(a, b string) bool { return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1 }

// LoopbackAddr returns addr with an empty host filled in as 127.0.0.1 (empty addr is 127.0.0.1:0) and rejects any non-loopback host.
func LoopbackAddr(addr string) (string, error) {
	if addr == "" {
		return "127.0.0.1:0", nil
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return "", err
	}
	if host == "" {
		return net.JoinHostPort("127.0.0.1", port), nil
	}
	if ip := net.ParseIP(host); host != "localhost" && (ip == nil || !ip.IsLoopback()) {
		return "", errors.New("local: " + host + " is not a loopback address")
	}
	return addr, nil
}
