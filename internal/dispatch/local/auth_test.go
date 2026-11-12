package local

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func serve(a *Auth, req *http.Request) int {
	rec := httptest.NewRecorder()
	a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })).ServeHTTP(rec, req)
	return rec.Code
}

func req(target, bearer string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, target, nil)
	if bearer != "" {
		r.Header.Set("Authorization", "Bearer "+bearer)
	}
	return r
}

func TestAuthMiddleware(t *testing.T) {
	a, err := NewAuth("hunter2")
	if err != nil {
		t.Fatal(err)
	}
	tok := a.Issue()
	tests := []struct {
		name string
		r    *http.Request
		want int
	}{
		{"no credentials is 401", req("/status", ""), 401},
		{"password accepted", req("/status", "hunter2"), 204},
		{"session token accepted", req("/status", tok), 204},
		{"wrong password", req("/status", "nope"), 401},
		{"token in query string refused", req("/status?token="+tok, ""), 401},
		{"password in query string refused", req("/status?password=hunter2", ""), 401},
		{"non-bearer scheme refused", func() *http.Request {
			r := req("/status", "")
			r.Header.Set("Authorization", "Basic "+tok)
			return r
		}(), 401},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := serve(a, tc.r); got != tc.want {
				t.Fatalf("got %d want %d", got, tc.want)
			}
		})
	}
}

func TestRotatingPasswordInvalidatesTokens(t *testing.T) {
	old, _ := NewAuth("one")
	tok := old.Issue()
	if got := serve(old, req("/", tok)); got != 204 {
		t.Fatalf("token before rotation: %d", got)
	}
	rotated, _ := NewAuth("two")
	if got := serve(rotated, req("/", tok)); got != 401 {
		t.Fatalf("token after rotation: %d", got)
	}
}

func TestVerifyBranches(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	a, _ := NewAuth("pw")
	a.now = func() time.Time { return now }
	good := a.Issue()
	later := &Auth{password: a.password, now: func() time.Time { return now.Add(sessionTTL + time.Second) }}
	tests := []struct {
		name  string
		a     *Auth
		token string
		want  bool
	}{
		{"fresh", a, good, true},
		{"expired", later, good, false},
		{"no dot", a, "abc", false},
		{"three parts", a, good + ".x", false},
		{"non-numeric expiry", a, "x.y", false},
		{"tampered expiry", a, "9999999999." + good[len(good)-43:], false},
		{"empty", a, "", false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.a.verify(tc.token); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

func TestNewAuthRejectsEmptyPassword(t *testing.T) {
	if _, err := NewAuth(""); err == nil {
		t.Fatal("empty password accepted")
	}
}

func TestLoopbackAddr(t *testing.T) {
	tests := []struct {
		in, want string
		ok       bool
	}{
		{"", "127.0.0.1:0", true},
		{":8080", "127.0.0.1:8080", true},
		{"127.0.0.1:9", "127.0.0.1:9", true},
		{"localhost:9", "localhost:9", true},
		{"[::1]:9", "[::1]:9", true},
		{"0.0.0.0:9", "", false},
		{"192.168.1.5:9", "", false},
		{"bogus", "", false},
	}
	for _, tc := range tests {
		t.Run(tc.in, func(t *testing.T) {
			got, err := LoopbackAddr(tc.in)
			if (err == nil) != tc.ok || got != tc.want {
				t.Fatalf("got %q, %v", got, err)
			}
		})
	}
}
