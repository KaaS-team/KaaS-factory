// Ported from coder/agentapi@7c468d5 lib/httpapi/server.go
// Copyright (c) 2025 Coder Technologies, Inc. MIT licence, see THIRD_PARTY_NOTICES.md.

// Package hostguard rejects requests whose Host or Origin header is not on an allow-list, which
// stops DNS-rebinding and cross-site requests against a local control listener.
package hostguard

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"unicode"
)

// HostsEnv and OriginsEnv name the comma-separated lists that extend the loopback default.
const (
	HostsEnv   = "FACTORY_ALLOWED_HOSTS"
	OriginsEnv = "FACTORY_ALLOWED_ORIGINS"
)

var loopback = []string{"localhost", "127.0.0.1", "::1"}

// New returns middleware that answers 403 when the Host header (port ignored) is not allowed, or when
// an Origin header is present and not allowed. It allows loopback hosts and origins, the host in
// listenAddr, and the entries of getenv(HostsEnv) and getenv(OriginsEnv); "*" allows everything. A
// listenAddr with no host (":8787", "0.0.0.0:8787") allows any Host, since the operator chose to
// expose it. A malformed list is ignored, leaving the loopback default.
func New(listenAddr string, getenv func(string) string) func(http.Handler) http.Handler {
	hosts, origins := slices.Clone(loopback), []string(nil)
	if h, _, err := net.SplitHostPort(listenAddr); err == nil {
		if ip := net.ParseIP(h); h == "" || (ip != nil && ip.IsUnspecified()) {
			hosts = []string{"*"}
		} else {
			hosts = append(hosts, h)
		}
	}
	if l, err := parseHosts(split(getenv(HostsEnv))); err == nil {
		hosts = append(hosts, l...)
	}
	if l, err := parseOrigins(split(getenv(OriginsEnv))); err == nil {
		origins = l
	}
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !hostOK(hosts, r.Host) || !originOK(origins, r.Header.Get("Origin")) {
				http.Error(w, "forbidden host or origin", http.StatusForbidden)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func split(s string) []string {
	if strings.TrimSpace(s) == "" {
		return nil
	}
	parts := strings.Split(s, ",")
	for i := range parts {
		parts[i] = strings.TrimSpace(parts[i])
	}
	return parts
}

func hostOK(allowed []string, hostHeader string) bool {
	if slices.Contains(allowed, "*") {
		return true
	}
	u, err := url.Parse("http://" + hostHeader)
	if hostHeader == "" || err != nil {
		return false
	}
	return slices.ContainsFunc(allowed, func(a string) bool { return strings.EqualFold(a, u.Hostname()) })
}

// originOK allows a missing Origin (not a browser request), a loopback origin, or a listed one.
func originOK(allowed []string, origin string) bool {
	if origin == "" || slices.Contains(allowed, "*") || slices.Contains(allowed, origin) {
		return true
	}
	u, err := url.Parse(origin)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && slices.Contains(loopback, strings.ToLower(u.Hostname()))
}

func parseHosts(input []string) ([]string, error) {
	if len(input) == 0 {
		return nil, fmt.Errorf("the list must not be empty")
	}
	if slices.Contains(input, "*") {
		return []string{"*"}, nil
	}
	if err := checkChars(input); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(input))
	for _, item := range input {
		if strings.Contains(item, "http://") || strings.Contains(item, "https://") {
			return nil, fmt.Errorf("'%s' must not include http:// or https://", item)
		}
		u, err := url.Parse("http://" + strings.TrimSpace(item))
		if err != nil {
			return nil, fmt.Errorf("'%s' is not a valid host: %w", item, err)
		}
		if u.Port() != "" {
			return nil, fmt.Errorf("'%s' must not include a port", u.Host)
		}
		out = append(out, u.Hostname())
	}
	return out, nil
}

func parseOrigins(input []string) ([]string, error) {
	if len(input) == 0 {
		return nil, fmt.Errorf("the list must not be empty")
	}
	if slices.Contains(input, "*") {
		return []string{"*"}, nil
	}
	if err := checkChars(input); err != nil {
		return nil, err
	}
	out := make([]string, 0, len(input))
	for _, item := range input {
		u, err := url.Parse(strings.TrimSpace(item))
		if err != nil {
			return nil, fmt.Errorf("'%s' is not a valid origin: %w", item, err)
		}
		out = append(out, fmt.Sprintf("%s://%s", u.Scheme, u.Host))
	}
	return out, nil
}

func checkChars(input []string) error {
	for _, item := range input {
		if strings.ContainsFunc(item, unicode.IsSpace) {
			return fmt.Errorf("'%s' contains whitespace characters, which are not allowed", item)
		}
		if strings.Contains(item, ",") {
			return fmt.Errorf("'%s' contains comma characters, which are not allowed", item)
		}
	}
	return nil
}
