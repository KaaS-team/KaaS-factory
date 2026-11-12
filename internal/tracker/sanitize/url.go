// Ported from github/gh-aw@741ff0c actions/setup/js/sanitize_content_core.cjs (URL slice)
//
// MIT License, Copyright GitHub, Inc. RE2 has no lookaround, so the https and path boundaries are
// scanned by hand. Left out: the scheme-less "www." tag-aware scanner.

package sanitize

import (
	"net/url"
	"regexp"
	"strings"
)

const (
	urlStartDelims = "[\\s(\\[{\"'<=,>|`]"
	authorityChar  = "[^\\s/?#,()<>\\[\\]{}\"'`|\\\\]"
)

var (
	schemeUserinfoRe   = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]{0,30}://)((?:` + authorityChar + `|[\t\r\n])*)`)
	protoRelUserinfoRe = regexp.MustCompile(`(^|` + urlStartDelims + `)([/\\]{2})((?:` + authorityChar + `|[\t\r\n])*)`)
	pct25Re            = regexp.MustCompile(`(?i)%25([0-9A-Fa-f]{2})`)
	pct3aRe            = regexp.MustCompile(`(?i)%3a`)
	anyScheme          = regexp.MustCompile(`(?i)([a-z][a-z0-9+.-]*)(://)([\w.-]*)([^\s"'<>]*)`)
	bareScheme         = regexp.MustCompile(`(?i)(?:data|javascript|vbscript|about|mailto|tel|magnet):[^\s"'<>]*`)
	httpsHostRe        = regexp.MustCompile(`(?i)https://([\w.-]+(?::\d+)?)`)
	angleAutolinkRe    = regexp.MustCompile(`(?i)<https://([\w.-]+(?::\d+)?)(/[^\s<>|]*)?(?:\|([^<>]*))?>`)
	protoRelHostRe     = regexp.MustCompile(`(?i)(^|` + urlStartDelims + `)([/\\]{2})([\w.-]+(?::\d+)?)`)
	wwwRe              = regexp.MustCompile(`(?i)(^|[^a-z0-9])(www\.[^\s<>"'|\[\]]+)`)
)

// sanitizeURLs strips userinfo, redacts non-https schemes and redacts https hosts off the allowlist.
func sanitizeURLs(s string, allowed []string) string {
	return sanitizeDomains(sanitizeProtocols(s), allowed)
}

func stripUserinfo(s string) string {
	s = rewriteAuthority(schemeUserinfoRe, s, 1, 2, func(scheme, rest string) string { return scheme + rest })
	return rewriteAuthority(protoRelUserinfoRe, s, 1, 3, func(prefix, rest string) string { return prefix + "//" + rest })
}

// rewriteAuthority drops everything up to the last "@" of the authority text; tab, CR and LF are
// removed first because URL parsers discard them.
func rewriteAuthority(re *regexp.Regexp, s string, headGroup, authGroup int, join func(head, rest string) string) string {
	return replaceIdx(re, s, func(m []int) string {
		auth := strings.NewReplacer("\t", "", "\r", "", "\n", "").Replace(s[m[2*authGroup]:m[2*authGroup+1]])
		at := strings.LastIndexByte(auth, '@')
		if at < 0 {
			return s[m[0]:m[1]]
		}
		return join(s[m[2*headGroup]:m[2*headGroup+1]], auth[at+1:])
	})
}

func sanitizeProtocols(s string) string {
	s = stripUserinfo(s)
	for range 4 {
		n := pct25Re.ReplaceAllString(s, "%$1")
		if n == s {
			break
		}
		s = n
	}
	s = pct3aRe.ReplaceAllString(s, ":")
	s = replaceIdx(anyScheme, s, func(m []int) string {
		if strings.EqualFold(s[m[2]:m[3]], "https") {
			return s[m[0]:m[1]]
		}
		domain := strings.ToLower(s[m[6]:m[7]])
		if name := domainName(domain); name != "" {
			return "(" + name + "/redacted)"
		}
		return "(redacted)"
	})
	return replaceIdx(bareScheme, s, func(m []int) string {
		if m[1] == m[0]+strings.IndexByte(s[m[0]:m[1]], ':')+1 && (m[1] >= len(s) || isSpace(s[m[1]])) {
			return s[m[0]:m[1]] // "data:" followed by nothing is prose, not a URI
		}
		return "(redacted)"
	})
}

// domainName keeps only alphanumerics per label and shortens long names to 24 characters at each end.
func domainName(d string) string {
	var parts []string
	for _, p := range strings.Split(d, ".") {
		if p = strings.Map(func(r rune) rune {
			if r < 128 && (r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
				return r
			}
			return -1
		}, p); p != "" {
			parts = append(parts, p)
		}
	}
	j := strings.Join(parts, ".")
	if len(j) > 48 {
		return j[:24] + "\u2026" + j[len(j)-24:]
	}
	return j
}

func hostAllowed(host string, allowed []string) bool {
	for _, a := range allowed {
		a = strings.ToLower(a)
		if base, ok := strings.CutPrefix(a, "*."); ok {
			if host == base || strings.HasSuffix(host, "."+base) {
				return true
			}
		} else if host == a || strings.HasSuffix(host, "."+a) {
			return true
		}
	}
	return false
}

// filterHost returns url unchanged when host is allowed, else a "(host/redacted)" placeholder.
func filterHost(url, hostPort string, allowed []string) string {
	host := strings.ToLower(strings.SplitN(hostPort, ":", 2)[0])
	if hostAllowed(host, allowed) {
		return url
	}
	if name := strings.TrimPrefix(domainName(host), "www."); name != "" {
		if strings.HasPrefix(host, "www.") {
			name = "www[.]" + name
		}
		return "(" + name + "/redacted)"
	}
	return "(redacted)"
}

func sanitizeDomains(s string, allowed []string) string {
	s = stripUserinfo(s)
	s = replaceIdx(angleAutolinkRe, s, func(m []int) string {
		full := s[m[0]:m[1]]
		u := "https://" + s[m[2]:m[3]]
		if m[4] >= 0 {
			u += s[m[4]:m[5]]
		}
		f := filterHost(u, s[m[2]:m[3]], allowed)
		if f == u {
			return full
		}
		if m[6] >= 0 && s[m[6]:m[7]] != "" {
			return f + "|" + s[m[6]:m[7]]
		}
		return f
	})
	s = redactHTTPS(s, allowed)
	s = redactProtoRelative(s, allowed)
	return filterWWW(s, allowed)
}

// redactProtoRelative filters //host/path URLs, which a browser on an https page resolves to https.
func redactProtoRelative(s string, allowed []string) string {
	var b strings.Builder
	last := 0
	for _, m := range protoRelHostRe.FindAllStringSubmatchIndex(s, -1) {
		if m[0] < last {
			continue
		}
		end := pathEnd(s, m[1], false)
		b.WriteString(s[last:m[2]])
		b.WriteString(s[m[2]:m[3]])
		b.WriteString(filterHost("//"+s[m[6]:m[7]]+s[m[1]:end], s[m[6]:m[7]], allowed))
		last = end
	}
	b.WriteString(s[last:])
	return b.String()
}

// redactHTTPS filters each https:// URL; its path stops before whitespace, ", ', <, > and the next https://.
func redactHTTPS(s string, allowed []string) string {
	var b strings.Builder
	last := 0
	for _, m := range httpsHostRe.FindAllStringSubmatchIndex(s, -1) {
		if m[0] < last {
			continue
		}
		end := m[1]
		if end < len(s) && s[end] == '/' {
			end = pathEnd(s, end, true)
		}
		b.WriteString(s[last:m[0]])
		b.WriteString(filterHost(s[m[0]:end], s[m[2]:m[3]], allowed))
		last = end
	}
	b.WriteString(s[last:])
	return b.String()
}

func pathEnd(s string, i int, stopHTTPS bool) int {
	if i >= len(s) || s[i] != '/' {
		return i
	}
	for i < len(s) {
		c := s[i]
		if isSpace(c) || strings.IndexByte(",\"'<>", c) >= 0 {
			break
		}
		if stopHTTPS && len(s)-i >= 8 && strings.EqualFold(s[i:i+8], "https://") {
			break
		}
		if !stopHTTPS && i+1 < len(s) && (c == '/' || c == '\\') && (s[i+1] == '/' || s[i+1] == '\\') {
			break
		}
		i++
	}
	return i
}

// filterWWW redacts scheme-less "www." hosts that are off the allowlist.
func filterWWW(s string, allowed []string) string {
	return replaceIdx(wwwRe, s, func(m []int) string {
		prefix, cand := s[m[2]:m[3]], s[m[4]:m[5]]
		trimmed := strings.TrimRight(cand, "?!.,:;>*_~")
		suffix := cand[len(trimmed):]
		u, err := url.Parse("https://" + strings.ReplaceAll(trimmed, `\`, "%5C"))
		if err != nil || u.Hostname() == "" {
			return prefix + "(redacted)" + suffix
		}
		host := strings.ToLower(u.Hostname())
		if hostAllowed(host, allowed) {
			if at := strings.LastIndexByte(trimmed, '@'); at >= 0 && !strings.ContainsAny(trimmed[:at], "/?#") {
				trimmed = trimmed[at+1:]
			}
			return prefix + trimmed + suffix
		}
		return prefix + filterHost("", host, allowed) + suffix
	})
}
