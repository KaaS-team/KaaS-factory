package egress

import (
	"bufio"
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
)

// ErrDenied is returned when the egress rules refuse a destination.
var ErrDenied = errors.New("egress: destination denied")

// Proxy is the one door out of a session. It enforces Net on every connection,
// and for hosts a secret may go to it terminates TLS with CA, swaps each
// placeholder in the request headers for its real value, and forwards over a
// verified TLS connection. Any placeholder it may not resolve refuses the whole
// request. Hosts with no secret rule are tunnelled untouched, so a placeholder
// sent there stays a literal string. Build the zero value up with the fields
// below; Net, Secrets and CA are required.
type Proxy struct {
	Net     Network
	Secrets *Secrets
	CA      *CA
	// Lookup resolves a host name; nil uses the system resolver.
	Lookup func(ctx context.Context, host string) ([]net.IP, error)
	// Dial opens the outbound connection to an ip:port; nil uses net.Dialer.
	Dial func(ctx context.Context, network, addr string) (net.Conn, error)
	// UpstreamTLS configures verification of destination servers; nil means defaults.
	UpstreamTLS *tls.Config

	once sync.Once
	tr   *http.Transport
}

// ServeHTTP handles CONNECT and plain proxy requests.
func (p *Proxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodConnect {
		p.connect(w, r)
		return
	}
	if !r.URL.IsAbs() {
		http.Error(w, "egress: not a proxy request", http.StatusBadRequest)
		return
	}
	// A secret never travels in cleartext, so any placeholder here is refused.
	if hasPlaceholder(r.Header, r.URL) {
		http.Error(w, "egress: placeholders are not resolved over cleartext http", http.StatusForbidden)
		return
	}
	if err := p.check(r.Context(), r.URL.Hostname()); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	out := r.Clone(r.Context())
	out.RequestURI = ""
	out.Header.Del("Proxy-Connection")
	resp, err := p.transport().RoundTrip(out)
	if err != nil {
		http.Error(w, "egress: upstream unreachable", http.StatusBadGateway)
		return
	}
	defer func() { _ = resp.Body.Close() }()
	for k, v := range resp.Header {
		w.Header()[k] = v
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (p *Proxy) connect(w http.ResponseWriter, r *http.Request) {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil {
		host, port = r.Host, "443"
	}
	if err := p.check(r.Context(), host); err != nil {
		http.Error(w, err.Error(), http.StatusForbidden)
		return
	}
	var up net.Conn
	if !p.Secrets.AppliesTo(host) {
		if up, err = p.dial(r.Context(), host, port); err != nil {
			http.Error(w, "egress: upstream unreachable", http.StatusBadGateway)
			return
		}
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		if up != nil {
			_ = up.Close()
		}
		http.Error(w, "egress: cannot hijack", http.StatusInternalServerError)
		return
	}
	conn, _, err := hj.Hijack()
	if err != nil {
		if up != nil {
			_ = up.Close()
		}
		return
	}
	defer func() { _ = conn.Close() }()
	_, _ = io.WriteString(conn, "HTTP/1.1 200 Connection Established\r\n\r\n")
	if up != nil {
		tunnel(conn, up)
		return
	}
	p.intercept(r.Context(), conn, host, port)
}

func tunnel(a, b net.Conn) {
	defer func() { _ = b.Close() }()
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(b, a)
		_ = b.Close()
		close(done)
	}()
	_, _ = io.Copy(a, b)
	_ = a.Close()
	<-done
}

// intercept reads each request on the agent's TLS connection, resolves its
// placeholders for host, and forwards it. The destination is always the host
// named in CONNECT, whatever the Host header says.
func (p *Proxy) intercept(ctx context.Context, conn net.Conn, host, port string) {
	tc := tls.Server(conn, &tls.Config{
		MinVersion:     tls.VersionTLS12,
		NextProtos:     []string{"http/1.1"},
		GetCertificate: func(*tls.ClientHelloInfo) (*tls.Certificate, error) { return p.CA.leaf(host) },
	})
	if tc.HandshakeContext(ctx) != nil {
		return
	}
	br := bufio.NewReader(tc)
	for {
		req, err := http.ReadRequest(br)
		if err != nil {
			return
		}
		resp := p.forward(ctx, req, host, port)
		err = resp.Write(tc)
		_ = resp.Body.Close()
		if err != nil || resp.Close || req.Close {
			return
		}
	}
}

func (p *Proxy) forward(ctx context.Context, req *http.Request, host, port string) *http.Response {
	if hasPlaceholder(nil, req.URL) {
		return refusal("egress: placeholders are only resolved in headers")
	}
	if req.Header.Get("Upgrade") != "" {
		return refusal("egress: upgrades are not proxied")
	}
	for k, vs := range req.Header {
		for i, v := range vs {
			x, err := p.Secrets.Expand(host, v)
			if err != nil {
				return refusal(err.Error())
			}
			req.Header[k][i] = x
		}
	}
	req.RequestURI = ""
	req.Header.Del("Proxy-Connection")
	authority := host
	if port != "443" {
		authority = net.JoinHostPort(host, port)
	}
	req.URL.Scheme, req.URL.Host, req.Host = "https", authority, authority
	resp, err := p.transport().RoundTrip(req.WithContext(ctx))
	if err != nil {
		return refusalStatus(http.StatusBadGateway, "egress: upstream unreachable")
	}
	return resp
}

func refusal(msg string) *http.Response { return refusalStatus(http.StatusForbidden, msg) }

func refusalStatus(code int, msg string) *http.Response {
	return &http.Response{
		StatusCode: code, Status: fmt.Sprintf("%d %s", code, http.StatusText(code)),
		ProtoMajor: 1, ProtoMinor: 1, Close: true, ContentLength: int64(len(msg)),
		Header: http.Header{"Content-Type": {"text/plain"}}, Body: io.NopCloser(strings.NewReader(msg)),
	}
}

// hasPlaceholder reports a placeholder in the headers or the URL, raw or percent-encoded.
func hasPlaceholder(h http.Header, u *url.URL) bool {
	has := func(s string) bool {
		if strings.Contains(s, placeholderPrefix) {
			return true
		}
		d, err := url.QueryUnescape(s)
		return err == nil && strings.Contains(d, placeholderPrefix)
	}
	for _, vs := range h {
		for _, v := range vs {
			if strings.Contains(v, placeholderPrefix) {
				return true
			}
		}
	}
	return u != nil && (has(u.RawQuery) || has(u.EscapedPath()) || has(u.Host) || has(u.RawFragment))
}

// check applies the egress rules to host, resolving it so a name that points
// into a denied range is refused too.
func (p *Proxy) check(ctx context.Context, host string) error {
	ips, err := p.resolve(ctx, host)
	if err != nil {
		return fmt.Errorf("egress: cannot resolve %s", host)
	}
	if !p.Net.Allowed(host, ips) {
		return fmt.Errorf("%w: %s", ErrDenied, host)
	}
	return nil
}

func (p *Proxy) resolve(ctx context.Context, host string) ([]net.IP, error) {
	if ip := net.ParseIP(host); ip != nil {
		return []net.IP{ip}, nil
	}
	if p.Lookup != nil {
		return p.Lookup(ctx, host)
	}
	return net.DefaultResolver.LookupIP(ctx, "ip", host)
}

// dial checks the rules and then connects to the resolved address, so the
// address that was checked is the one used.
func (p *Proxy) dial(ctx context.Context, host, port string) (net.Conn, error) {
	ips, err := p.resolve(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, fmt.Errorf("egress: cannot resolve %s", host)
	}
	if !p.Net.Allowed(host, ips) {
		return nil, fmt.Errorf("%w: %s", ErrDenied, host)
	}
	d := p.Dial
	if d == nil {
		d = (&net.Dialer{}).DialContext
	}
	return d(ctx, "tcp", net.JoinHostPort(ips[0].String(), port))
}

func (p *Proxy) transport() *http.Transport {
	p.once.Do(func() {
		p.tr = &http.Transport{
			DisableKeepAlives: true,
			TLSClientConfig:   p.UpstreamTLS,
			DialContext: func(ctx context.Context, _, addr string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(addr)
				if err != nil {
					return nil, err
				}
				return p.dial(ctx, host, port)
			},
		}
	})
	return p.tr
}
