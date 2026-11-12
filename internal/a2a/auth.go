package a2a

import (
	"crypto/sha256"
	"crypto/subtle"
	"net/http"
	"strings"
)

// bearer refuses with 401 every request that lacks the token. An empty token matches nothing.
func bearer(token string, next http.Handler) http.Handler {
	want := sha256.Sum256([]byte(token))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
		have := sha256.Sum256([]byte(got))
		if token == "" || !ok || subtle.ConstantTimeCompare(have[:], want[:]) != 1 {
			w.Header().Set("WWW-Authenticate", `Bearer realm="factory"`)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		next.ServeHTTP(w, r)
	})
}
