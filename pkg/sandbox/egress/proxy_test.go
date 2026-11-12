package egress

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

const realValue = "ghp_real_value_123"

// rig is a proxy in front of one local TLS upstream. Every hostname resolves
// to the address in lookupIP and every dial lands on the upstream.
type rig struct {
	proxy    *httptest.Server
	ca       *CA
	upstream *httptest.Server
	dials    atomic.Int32
	seen     chan http.Header // headers the upstream received
	client   *http.Client
}

func newRig(t *testing.T, n Network, lookupIP string) *rig {
	t.Helper()
	r := &rig{seen: make(chan http.Header, 8)}
	r.upstream = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, q *http.Request) {
		r.seen <- q.Header.Clone()
		_, _ = io.WriteString(w, "ok")
	}))
	t.Cleanup(r.upstream.Close)
	secrets, err := NewSecrets(DefaultMinWildcardLabels,
		Secret{Name: "GH_TOKEN", Value: realValue, Hosts: []string{"api.github.com"}},
		Secret{Name: "NPM_TOKEN", Value: "npm_real", Hosts: []string{"*.npmjs.org"}})
	if err != nil {
		t.Fatal(err)
	}
	if r.ca, err = NewCA(); err != nil {
		t.Fatal(err)
	}
	pool := x509.NewCertPool()
	pool.AddCert(r.upstream.Certificate())
	p := &Proxy{
		Net: n, Secrets: secrets, CA: r.ca,
		Lookup: func(context.Context, string) ([]net.IP, error) { return []net.IP{net.ParseIP(lookupIP)}, nil },
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			r.dials.Add(1)
			return (&net.Dialer{}).DialContext(ctx, network, r.upstream.Listener.Addr().String())
		},
		UpstreamTLS: &tls.Config{RootCAs: pool, ServerName: "example.com"},
	}
	r.proxy = httptest.NewServer(p)
	t.Cleanup(r.proxy.Close)
	agentRoots := x509.NewCertPool()
	agentRoots.AppendCertsFromPEM(r.ca.PEM())
	pu, _ := url.Parse(r.proxy.URL)
	r.client = &http.Client{Transport: &http.Transport{
		Proxy:           http.ProxyURL(pu),
		TLSClientConfig: &tls.Config{RootCAs: agentRoots},
	}}
	t.Cleanup(r.client.CloseIdleConnections)
	return r
}

func (r *rig) get(t *testing.T, target, header string) (int, string, error) {
	t.Helper()
	req, _ := http.NewRequest("GET", target, nil)
	req.Header.Set("Authorization", header)
	resp, err := r.client.Do(req)
	if err != nil {
		return 0, "", err
	}
	defer func() { _ = resp.Body.Close() }()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), nil
}

func (r *rig) lastHeader(t *testing.T) http.Header {
	t.Helper()
	select {
	case h := <-r.seen:
		return h
	default:
		t.Fatal("upstream saw no request")
		return nil
	}
}

func TestProxyInjectsTheRealValueOnlyForAnAllowedHostOverTLS(t *testing.T) {
	r := newRig(t, Network{}, "140.82.112.5")
	code, _, err := r.get(t, "https://api.github.com/user", "Bearer ${kaas.secret.GH_TOKEN}")
	if err != nil || code != 200 {
		t.Fatalf("code %d err %v", code, err)
	}
	if got := r.lastHeader(t).Get("Authorization"); got != "Bearer "+realValue {
		t.Fatalf("upstream got %q", got)
	}
}

func TestProxyWildcardHostGetsItsSecret(t *testing.T) {
	r := newRig(t, Network{}, "104.16.0.1")
	if code, _, err := r.get(t, "https://registry.npmjs.org/x", "${kaas.secret.NPM_TOKEN}"); err != nil || code != 200 {
		t.Fatalf("code %d err %v", code, err)
	}
	if got := r.lastHeader(t).Get("Authorization"); got != "npm_real" {
		t.Fatalf("got %q", got)
	}
}

// The leak test: a hostile destination asking for a secret fails closed.
func TestProxyHostileHostNeverReceivesAValue(t *testing.T) {
	cases := []struct {
		name, url, header string
		wantStatus        int // 0: the request is tunnelled and the upstream sees the literal placeholder
	}{
		{"secret host, other secret", "https://registry.npmjs.org/x", "${kaas.secret.GH_TOKEN}", 403},
		{"secret host, unknown name", "https://api.github.com/x", "${kaas.secret.NOPE}", 403},
		{"placeholder in the url", "https://api.github.com/x?k=${kaas.secret.GH_TOKEN}", "", 403},
		{"placeholder in the url, escaped", "https://api.github.com/x?k=%24%7Bkaas.secret.GH_TOKEN%7D", "", 403},
		{"cleartext http to the secret host", "http://api.github.com/x", "${kaas.secret.GH_TOKEN}", 403},
		{"cleartext http to a hostile host", "http://evil.example/x", "${kaas.secret.GH_TOKEN}", 403},
		{"lookalike suffix is tunnelled, literal text only", "https://api.github.com.evil.example/x", "${kaas.secret.GH_TOKEN}", 0},
		{"unlisted host is tunnelled, literal text only", "https://evil.example/x", "${kaas.secret.GH_TOKEN}", 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t, Network{}, "203.0.113.9")
			if strings.HasPrefix(c.url, "https://evil.example") || strings.Contains(c.url, "evil.example") {
				// End to end TLS through a plain tunnel: the client must trust the upstream itself.
				pool := x509.NewCertPool()
				pool.AddCert(r.upstream.Certificate())
				r.client.Transport.(*http.Transport).TLSClientConfig = &tls.Config{RootCAs: pool, ServerName: "example.com"}
			}
			code, body, err := r.get(t, c.url, c.header)
			if c.wantStatus == 0 {
				if err != nil || code != 200 {
					t.Fatalf("code %d err %v", code, err)
				}
				if got := r.lastHeader(t).Get("Authorization"); got != c.header {
					t.Fatalf("tunnel must carry the placeholder untouched, got %q", got)
				}
				return
			}
			// A refused CONNECT surfaces as a client error; a refused request as a 403.
			if err == nil && code != c.wantStatus {
				t.Fatalf("code %d, want %d", code, c.wantStatus)
			}
			if strings.Contains(body, realValue) {
				t.Fatalf("value in error body: %q", body)
			}
			select {
			case h := <-r.seen:
				t.Fatalf("upstream must not be reached, saw %v", h)
			default:
			}
		})
	}
}

func TestProxyEgressRulesFailClosedBeforeDialing(t *testing.T) {
	cases := []struct {
		name   string
		net    Network
		ip     string
		target string
	}{
		{"denied domain", Network{DenyOut: []string{"api.github.com"}}, "140.82.112.5", "https://api.github.com/"},
		{"denied wildcard", Network{DenyOut: []string{"*.github.com"}}, "140.82.112.5", "https://api.github.com/"},
		{"name resolves into a denied cidr", Network{DenyOut: []string{"10.0.0.0/8"}}, "10.1.1.1", "https://api.github.com/"},
		{"deny everything", Network{DenyOut: []string{"0.0.0.0/0"}}, "140.82.112.5", "https://api.github.com/"},
		{"deny everything, plain tunnel host", Network{DenyOut: []string{"0.0.0.0/0"}}, "140.82.112.5", "https://other.example/"},
		{"deny everything, cleartext", Network{DenyOut: []string{"0.0.0.0/0"}}, "140.82.112.5", "http://other.example/"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := newRig(t, c.net, c.ip)
			if code, _, err := r.get(t, c.target, ""); err == nil && code != 403 {
				t.Fatalf("want refusal, got %d", code)
			}
			if n := r.dials.Load(); n != 0 {
				t.Fatalf("dialed %d times", n)
			}
		})
	}
}

func TestProxyAllowOutWinsOverDeny(t *testing.T) {
	r := newRig(t, Network{AllowOut: []string{"api.github.com"}, DenyOut: []string{"0.0.0.0/0"}}, "140.82.112.5")
	if code, _, err := r.get(t, "https://api.github.com/", "${kaas.secret.GH_TOKEN}"); err != nil || code != 200 {
		t.Fatalf("code %d err %v", code, err)
	}
}

func TestCALeafCoversTheHost(t *testing.T) {
	ca, err := NewCA()
	if err != nil {
		t.Fatal(err)
	}
	c, err := ca.leaf("api.github.com")
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca.PEM())
	leaf, _ := x509.ParseCertificate(c.Certificate[0])
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "api.github.com"}); err != nil {
		t.Fatal(err)
	}
	if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, DNSName: "evil.example"}); err == nil {
		t.Fatal("leaf must not cover another host")
	}
}
