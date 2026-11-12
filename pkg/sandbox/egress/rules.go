package egress

import (
	"fmt"
	"net"
	"net/netip"
	"strings"
)

// Network is the egress allow and deny config for one session. An entry is a
// CIDR block, a bare IP, an exact domain, or a leading wildcard such as
// "*.example.com" (any depth, never the apex). A non-public address is always
// refused; otherwise allow wins over deny, and a destination that matches
// neither list is allowed.
type Network struct {
	AllowOut []string `json:"allowOut,omitempty"`
	DenyOut  []string `json:"denyOut,omitempty"`
	// DNSServers are the IPv4 resolvers the session may reach. Nil means the
	// default 8.8.8.8; an empty non-nil list means none.
	DNSServers []string `json:"dnsServers,omitempty"`
}

// Allowed reports whether a connection to host, which resolved to ips, may go
// out. Any non-public address refuses it whatever the lists say, so no allow
// entry can open the host, its network or a cloud metadata service. Then allow
// is checked and wins; then deny; otherwise the answer is yes.
func (n Network) Allowed(host string, ips []net.IP) bool {
	host = normalizeHost(host)
	if hostIP := net.ParseIP(host); hostIP != nil {
		ips = append(ips[:len(ips):len(ips)], hostIP)
	}
	for _, ip := range ips {
		if NonPublic(ip) {
			return false
		}
	}
	if matchAny(n.AllowOut, host, ips) {
		return true
	}
	return !matchAny(n.DenyOut, host, ips)
}

// nonPublicPrefixes are the IANA special-purpose ranges Go's net.IP predicates miss: "this
// network", IETF protocol assignments, carrier-grade NAT, benchmarking, reserved and broadcast,
// and the Teredo tunnel prefix.
var nonPublicPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),
	netip.MustParsePrefix("100.64.0.0/10"),
	netip.MustParsePrefix("192.0.0.0/24"),
	netip.MustParsePrefix("198.18.0.0/15"),
	netip.MustParsePrefix("240.0.0.0/4"), // reserved, and the broadcast address inside it
	netip.MustParsePrefix("2001::/32"),
}

var (
	nat64  = netip.MustParsePrefix("64:ff9b::/96")
	sixTo4 = netip.MustParsePrefix("2002::/16")
)

// NonPublic reports whether ip is an address a session must never reach: loopback, private
// (RFC 1918 and IPv6 ULA), link-local (which holds the cloud metadata address 169.254.169.254),
// multicast, unspecified, carrier-grade NAT, benchmarking, reserved, Teredo, or an IPv4 address
// of those kinds inside an IPv4-mapped, NAT64 or 6to4 IPv6 address. A malformed ip counts as
// non-public.
func NonPublic(ip net.IP) bool {
	addr, ok := netip.AddrFromSlice(ip)
	if !ok {
		return true
	}
	return nonPublicAddr(addr.Unmap())
}

func nonPublicAddr(a netip.Addr) bool {
	b := a.As16()
	switch {
	case a.Is4In6():
		return nonPublicAddr(a.Unmap())
	case a.Is6() && nat64.Contains(a):
		return nonPublicAddr(netip.AddrFrom4([4]byte(b[12:16])))
	case a.Is6() && sixTo4.Contains(a):
		return nonPublicAddr(netip.AddrFrom4([4]byte(b[2:6])))
	}
	if a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() {
		return true
	}
	for _, p := range nonPublicPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
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
