package egress

import (
	"fmt"
	"net"
	"strings"
)

// Network is the egress allow and deny config for one session. An entry is a
// CIDR block, a bare IP, an exact domain, or a leading wildcard such as
// "*.example.com" (any depth, never the apex). Allow wins over deny, and a
// destination that matches neither list is allowed.
type Network struct {
	AllowOut []string `json:"allowOut,omitempty"`
	DenyOut  []string `json:"denyOut,omitempty"`
	// DNSServers are the IPv4 resolvers the session may reach. Nil means the
	// default 8.8.8.8; an empty non-nil list means none.
	DNSServers []string `json:"dnsServers,omitempty"`
}

// Allowed reports whether a connection to host, which resolved to ips, may go
// out. Allow is checked first and wins; then deny; otherwise the answer is yes.
func (n Network) Allowed(host string, ips []net.IP) bool {
	host = normalizeHost(host)
	if hostIP := net.ParseIP(host); hostIP != nil {
		ips = append(ips[:len(ips):len(ips)], hostIP)
	}
	if matchAny(n.AllowOut, host, ips) {
		return true
	}
	return !matchAny(n.DenyOut, host, ips)
}

// DNS returns the resolvers the session may reach, applying the default.
func (n Network) DNS() []string {
	if n.DNSServers == nil {
		return []string{"8.8.8.8"}
	}
	return n.DNSServers
}

// Validate rejects entries the matcher cannot read, so a typo fails at session
// start instead of silently allowing or denying nothing.
func (n Network) Validate() error {
	for _, list := range [][]string{n.AllowOut, n.DenyOut} {
		for _, e := range list {
			if err := validEntry(e); err != nil {
				return err
			}
		}
	}
	for _, d := range n.DNSServers {
		if ip := net.ParseIP(d); ip == nil || ip.To4() == nil {
			return fmt.Errorf("dns server %q is not an IPv4 address", d)
		}
	}
	return nil
}

func validEntry(e string) error {
	switch {
	case e == "":
		return fmt.Errorf("empty egress entry")
	case strings.Contains(e, "/"):
		if _, _, err := net.ParseCIDR(e); err != nil {
			return fmt.Errorf("egress entry %q: %w", e, err)
		}
	case strings.HasPrefix(e, "*."):
		if strings.Contains(e[2:], "*") || e[2:] == "" {
			return fmt.Errorf("egress entry %q: only one leading wildcard label is allowed", e)
		}
	case strings.Contains(e, "*"):
		return fmt.Errorf("egress entry %q: a wildcard must be the whole leading label", e)
	}
	return nil
}

func normalizeHost(h string) string {
	return strings.TrimSuffix(strings.ToLower(h), ".")
}

func matchAny(entries []string, host string, ips []net.IP) bool {
	for _, e := range entries {
		if matchEntry(e, host, ips) {
			return true
		}
	}
	return false
}

func matchEntry(e, host string, ips []net.IP) bool {
	if strings.Contains(e, "/") {
		_, cidr, err := net.ParseCIDR(e)
		if err != nil {
			return false
		}
		for _, ip := range ips {
			if cidr.Contains(ip) {
				return true
			}
		}
		return false
	}
	if eip := net.ParseIP(e); eip != nil {
		for _, ip := range ips {
			if eip.Equal(ip) {
				return true
			}
		}
		return false
	}
	return matchHost(e, host)
}

// matchHost matches a domain pattern: exact, or "*.suffix" for any subdomain
// of suffix at any depth but not suffix itself.
func matchHost(pattern, host string) bool {
	pattern = normalizeHost(pattern)
	if suffix, ok := strings.CutPrefix(pattern, "*."); ok {
		return strings.HasSuffix(host, "."+suffix)
	}
	return pattern == host
}
