package hostguard

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func do(t *testing.T, g func(http.Handler) http.Handler, host, origin string) int {
	t.Helper()
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) })
	r := httptest.NewRequest(http.MethodGet, "http://"+host+"/events", nil)
	r.Host = host
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	w := httptest.NewRecorder()
	g(next).ServeHTTP(w, r)
	return w.Code
}

// Symphony 8.1: the loop's control listener is loopback by default.
func TestLoopbackDefault(t *testing.T) {
	g := New("127.0.0.1:8787", func(string) string { return "" })
	for _, c := range []struct {
		name, host, origin string
		want               int
	}{
		{"loopback ip", "127.0.0.1:8787", "", 204},
		{"localhost", "localhost:8787", "", 204},
		{"ipv6", "[::1]:8787", "", 204},
		{"uppercase host", "LOCALHOST", "", 204},
		{"dns rebinding host", "evil.example.com:8787", "", 403},
		{"rebinding host with loopback prefix", "127.0.0.1.evil.com", "", 403},
		{"empty host", "", "", 403},
		{"loopback origin", "localhost:8787", "http://localhost:3000", 204},
		{"foreign origin", "localhost:8787", "https://evil.example.com", 403},
		{"null origin", "localhost:8787", "null", 403},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := do(t, g, c.host, c.origin); got != c.want {
				t.Fatalf("host %q origin %q: got %d want %d", c.host, c.origin, got, c.want)
			}
		})
	}
}

func TestFromAddrAndEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }
	for _, c := range []struct {
		name, addr string
		env        map[string]string
		host, orig string
		want       int
	}{
		{"named bind host allowed", "factory.internal:8787", nil, "factory.internal:8787", "", 204},
		{"named bind host still blocks others", "factory.internal:8787", nil, "evil.com", "", 403},
		{"wildcard bind allows any host", ":8787", nil, "anything.example", "", 204},
		{"wildcard bind 0.0.0.0", "0.0.0.0:8787", nil, "anything.example", "", 204},
		{"env host added", "127.0.0.1:1", map[string]string{HostsEnv: "a.example, b.example"}, "b.example", "", 204},
		{"env host star", "127.0.0.1:1", map[string]string{HostsEnv: "*"}, "x.example", "", 204},
		{"env origin allowed", "127.0.0.1:1", map[string]string{OriginsEnv: "https://ui.example"}, "localhost", "https://ui.example", 204},
		{"env origin other blocked", "127.0.0.1:1", map[string]string{OriginsEnv: "https://ui.example"}, "localhost", "https://evil.example", 403},
		{"env origin star", "127.0.0.1:1", map[string]string{OriginsEnv: "*"}, "localhost", "https://any.example", 204},
		{"bad env host falls back to loopback", "127.0.0.1:1", map[string]string{HostsEnv: "http://x"}, "x", "", 403},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := do(t, New(c.addr, env(c.env)), c.host, c.orig); got != c.want {
				t.Fatalf("got %d want %d", got, c.want)
			}
		})
	}
}

func TestParseHosts(t *testing.T) {
	for _, c := range []struct {
		name string
		in   []string
		want string // joined result, or "ERR"
	}{
		{"empty", nil, "ERR"},
		{"star", []string{"a", "*"}, "*"},
		{"whitespace", []string{"a b"}, "ERR"},
		{"comma", []string{"a,b"}, "ERR"},
		{"scheme", []string{"https://a"}, "ERR"},
		{"port", []string{"a:80"}, "ERR"},
		{"bad url", []string{"a%zz"}, "ERR"},
		{"ok", []string{"a.example", "[::1]"}, "a.example ::1"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseHosts(c.in)
			if (err != nil) != (c.want == "ERR") || (err == nil && strings.Join(got, " ") != c.want) {
				t.Fatalf("got %q %v want %s", got, err, c.want)
			}
		})
	}
}

func TestParseOrigins(t *testing.T) {
	for _, c := range []struct {
		name string
		in   []string
		want string
	}{
		{"empty", nil, "ERR"},
		{"star", []string{"*"}, "*"},
		{"whitespace", []string{"http://a b"}, "ERR"},
		{"comma", []string{"http://a,b"}, "ERR"},
		{"bad url", []string{"http://a%zz"}, "ERR"},
		{"ok", []string{"https://a.example:8080/path"}, "https://a.example:8080"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got, err := parseOrigins(c.in)
			if (err != nil) != (c.want == "ERR") || (err == nil && strings.Join(got, " ") != c.want) {
				t.Fatalf("got %q %v want %s", got, err, c.want)
			}
		})
	}
}
