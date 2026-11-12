package egress

import (
	"net"
	"testing"
)

func ips(s ...string) []net.IP {
	var out []net.IP
	for _, a := range s {
		out = append(out, net.ParseIP(a))
	}
	return out
}

func TestNetworkAllowed(t *testing.T) {
	cases := []struct {
		name string
		net  Network
		host string
		ips  []net.IP
		want bool
	}{
		{"no rules allows", Network{}, "example.com", nil, true},
		{"deny exact", Network{DenyOut: []string{"evil.com"}}, "evil.com", nil, false},
		{"deny exact is case blind", Network{DenyOut: []string{"Evil.com"}}, "EVIL.com.", nil, false},
		{"deny leaves others", Network{DenyOut: []string{"evil.com"}}, "good.com", nil, true},
		{"allow wins over deny, domain", Network{AllowOut: []string{"api.x.com"}, DenyOut: []string{"api.x.com"}}, "api.x.com", nil, true},
		{"allow wins over deny, wildcard in allow", Network{AllowOut: []string{"*.x.com"}, DenyOut: []string{"api.x.com"}}, "api.x.com", nil, true},
		{"wildcard matches one label", Network{DenyOut: []string{"*.x.com"}}, "a.x.com", nil, false},
		{"wildcard matches any depth", Network{DenyOut: []string{"*.x.com"}}, "a.b.x.com", nil, false},
		{"wildcard skips the apex", Network{DenyOut: []string{"*.x.com"}}, "x.com", nil, true},
		{"wildcard needs a label boundary", Network{DenyOut: []string{"*.x.com"}}, "notx.com", nil, true},
		{"deny cidr", Network{DenyOut: []string{"10.0.0.0/8"}}, "h.example", ips("10.1.2.3"), false},
		{"deny cidr outside", Network{DenyOut: []string{"10.0.0.0/8"}}, "h.example", ips("11.1.2.3"), true},
		{"deny bare ip", Network{DenyOut: []string{"8.8.8.8"}}, "8.8.8.8", nil, false},
		{"deny all cidr, allow domain", Network{AllowOut: []string{"ok.com"}, DenyOut: []string{"0.0.0.0/0"}}, "ok.com", ips("1.2.3.4"), true},
		{"deny all cidr, other host", Network{AllowOut: []string{"ok.com"}, DenyOut: []string{"0.0.0.0/0"}}, "other.com", ips("1.2.3.4"), false},
		{"allow cidr beats deny all", Network{AllowOut: []string{"1.2.3.0/24"}, DenyOut: []string{"0.0.0.0/0"}}, "h.example", ips("1.2.3.4"), true},
		{"one denied ip denies the host", Network{DenyOut: []string{"10.0.0.0/8"}}, "h.example", ips("1.1.1.1", "10.0.0.1"), false},
		{"ip literal host is checked as an ip", Network{DenyOut: []string{"10.0.0.0/8"}}, "10.9.9.9", nil, false},
		{"allow cidr never opens a private ip", Network{AllowOut: []string{"10.0.0.0/8"}}, "h.example", ips("10.1.2.3"), false},
		{"allow ip never opens metadata", Network{AllowOut: []string{"169.254.169.254"}}, "169.254.169.254", nil, false},
		{"allow domain never opens loopback", Network{AllowOut: []string{"ok.com"}}, "ok.com", ips("127.0.0.1"), false},
		{"one private answer refuses the host", Network{AllowOut: []string{"ok.com"}}, "ok.com", ips("1.2.3.4", "192.168.0.1"), false},
		{"no rules still refuse loopback", Network{}, "localhost", ips("::1"), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := c.net.Allowed(c.host, c.ips); got != c.want {
				t.Fatalf("Allowed(%q, %v) = %v, want %v", c.host, c.ips, got, c.want)
			}
		})
	}
}

func TestNetworkValidate(t *testing.T) {
	cases := []struct {
		name    string
		net     Network
		wantErr bool
	}{
		{"empty ok", Network{}, false},
		{"entries ok", Network{AllowOut: []string{"a.com", "*.b.com", "1.2.3.4", "10.0.0.0/8"}, DNSServers: []string{"8.8.8.8"}}, false},
		{"bare star", Network{DenyOut: []string{"*"}}, true},
		{"star mid label", Network{DenyOut: []string{"a.*.com"}}, true},
		{"empty entry", Network{AllowOut: []string{""}}, true},
		{"bad cidr", Network{DenyOut: []string{"10.0.0.0/99"}}, true},
		{"dns must be ipv4", Network{DNSServers: []string{"dns.google"}}, true},
		{"dns ipv6 rejected", Network{DNSServers: []string{"::1"}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := c.net.Validate(); (err != nil) != c.wantErr {
				t.Fatalf("Validate() = %v, wantErr %v", err, c.wantErr)
			}
		})
	}
}

func TestNonPublic(t *testing.T) {
	for _, a := range []string{"127.0.0.1", "127.9.9.9", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254",
		"169.254.0.1", "100.64.0.1", "0.0.0.0", "0.1.2.3", "255.255.255.255", "224.0.0.1", "::", "::1", "fe80::1",
		"fd00::1", "fc00::1", "ff02::1", "::ffff:10.0.0.1", "::ffff:169.254.169.254", "64:ff9b::7f00:1"} {
		if !NonPublic(net.ParseIP(a)) {
			t.Errorf("%s counted as public", a)
		}
	}
	for _, a := range []string{"1.1.1.1", "140.82.112.5", "203.0.113.9", "100.128.0.1", "2606:4700::1111", "64:ff9b::808:808"} {
		if NonPublic(net.ParseIP(a)) {
			t.Errorf("%s counted as non-public", a)
		}
	}
	if !NonPublic(nil) {
		t.Error("nil ip counted as public")
	}
}

func TestDNSServersDefault(t *testing.T) {
	// e2b openapi.yml: omit for 8.8.8.8, an empty list allows none.
	if got := (Network{}).DNS(); len(got) != 1 || got[0] != "8.8.8.8" {
		t.Fatalf("omitted = %v", got)
	}
	if got := (Network{DNSServers: []string{}}).DNS(); len(got) != 0 {
		t.Fatalf("empty list = %v", got)
	}
	if got := (Network{DNSServers: []string{"1.1.1.1"}}).DNS(); len(got) != 1 || got[0] != "1.1.1.1" {
		t.Fatalf("set = %v", got)
	}
}
