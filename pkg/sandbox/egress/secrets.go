package egress

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/net/publicsuffix"
)

const (
	placeholderPrefix = "${kaas.secret."
	placeholderSuffix = "}"
	// DefaultMinWildcardLabels is the fewest suffix labels a wildcard host may
	// have: "*.github.com" has two, "*.com" has one and is refused.
	DefaultMinWildcardLabels = 2
	redacted                 = "<secret-hidden>"
)

// ErrSecretNotPermitted is returned when a placeholder names no registered
// secret, or names one that may not go to the destination host.
var ErrSecretNotPermitted = errors.New("egress: secret not permitted for this host")

var envName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

// Secret is one credential the proxy may inject. The session sees only its
// placeholder; Value stays in the proxy.
type Secret struct {
	// Name is the environment variable the session sees.
	Name string `json:"name"`
	// Value is the real credential. It never prints, logs or marshals.
	Value string `json:"-"`
	// Hosts are the only destinations Value may be sent to: exact domains or
	// "*.suffix" wildcards no broader than the gate's depth.
	Hosts []string `json:"hosts"`
}

// String hides the value.
func (s Secret) String() string { return fmt.Sprintf("Secret{%s %v %s}", s.Name, s.Hosts, redacted) }

// GoString hides the value.
func (s Secret) GoString() string { return s.String() }

// LogValue hides the value from slog.
func (s Secret) LogValue() slog.Value { return slog.StringValue(s.String()) }

// Secrets is the set of credentials a proxy may inject. Build it with NewSecrets.
type Secrets struct{ list []Secret }

// String hides every value.
func (s *Secrets) String() string { return fmt.Sprintf("Secrets{%d %s}", len(s.list), redacted) }

// GoString hides every value.
func (s *Secrets) GoString() string { return s.String() }

// Placeholder returns the text the session carries in place of the secret name.
func Placeholder(name string) (string, error) {
	if err := ValidateTokenName(name); err != nil {
		return "", err
	}
	return placeholderPrefix + name + placeholderSuffix, nil
}

// NewSecrets is the gate: it rejects bad names, empty values, secrets with no
// host, hosts that are not domains, and wildcards with fewer than minLabels
// suffix labels or a public suffix as base (so "*.com" and "*.co.uk" cannot carry a credential to
// every host under them). A minLabels below 1 means DefaultMinWildcardLabels; the gate is never off.
func NewSecrets(minLabels int, list ...Secret) (*Secrets, error) {
	if minLabels < 1 {
		minLabels = DefaultMinWildcardLabels
	}
	seen := map[string]bool{}
	for _, s := range list {
		if err := ValidateTokenName(s.Name); err != nil {
			return nil, err
		}
		switch {
		case !envName.MatchString(s.Name):
			return nil, fmt.Errorf("secret name %q must be a valid environment variable name", s.Name)
		case seen[s.Name]:
			return nil, fmt.Errorf("secret %q is listed twice", s.Name)
		case s.Value == "":
			return nil, fmt.Errorf("secret %q has no value", s.Name)
		case len(s.Hosts) == 0:
			return nil, fmt.Errorf("secret %q lists no hosts", s.Name)
		}
		seen[s.Name] = true
		for _, h := range s.Hosts {
			if err := checkHost(h, minLabels); err != nil {
				return nil, fmt.Errorf("secret %q: %w", s.Name, err)
			}
		}
	}
	return &Secrets{list: append([]Secret(nil), list...)}, nil
}

func checkHost(h string, minLabels int) error {
	if h == "" || strings.ContainsAny(h, "/*") && !strings.HasPrefix(h, "*.") || net.ParseIP(h) != nil {
		return fmt.Errorf("host %q must be a domain or a leading wildcard", h)
	}
	if suffix, ok := strings.CutPrefix(h, "*."); ok {
		if strings.Contains(suffix, "*") || suffix == "" {
			return fmt.Errorf("host %q allows one leading wildcard label only", h)
		}
		if n := strings.Count(suffix, ".") + 1; n < minLabels {
			return fmt.Errorf("wildcard %q is broader than the allowed depth: it has %d suffix labels, the minimum is %d", h, n, minLabels)
		}
		if ps, _ := publicsuffix.PublicSuffix(strings.ToLower(suffix)); ps == strings.ToLower(suffix) {
			return fmt.Errorf("wildcard %q covers the public suffix %q, so it would match unrelated hosts", h, suffix)
		}
	}
	return nil
}

// Env returns NAME=placeholder for each secret whose name appears in command
// as a whole word. A secret the command never names is not injected.
func (s *Secrets) Env(command string) []string {
	var out []string
	for _, sec := range s.list {
		if hasWord(command, sec.Name) {
			p, _ := Placeholder(sec.Name)
			out = append(out, sec.Name+"="+p)
		}
	}
	return out
}

func hasWord(text, word string) bool {
	isWord := func(r rune) bool { return r == '_' || unicode.IsLetter(r) || unicode.IsDigit(r) }
	for i := 0; ; {
		j := strings.Index(text[i:], word)
		if j < 0 {
			return false
		}
		start, end := i+j, i+j+len(word)
		lr, _ := utf8.DecodeLastRuneInString(text[:start])
		fr, _ := utf8.DecodeRuneInString(text[end:])
		before := start == 0 || !isWord(lr)
		after := end == len(text) || !isWord(fr)
		if before && after {
			return true
		}
		i = start + 1
	}
}

// AppliesTo reports whether any secret may be sent to host, which is when the
// proxy has to read the request instead of tunnelling it.
func (s *Secrets) AppliesTo(host string) bool {
	host = normalizeHost(host)
	for _, sec := range s.list {
		if matchAny(sec.Hosts, host, nil) {
			return true
		}
	}
	return false
}

// Expand replaces each placeholder in text with its real value. It fails
// closed: a placeholder that names an unknown secret, or one not permitted for
// host, returns ErrSecretNotPermitted and no text. Substituted values are not
// scanned again, and an unterminated placeholder stays literal.
func (s *Secrets) Expand(host, text string) (string, error) {
	host = normalizeHost(host)
	var b strings.Builder
	for {
		i := strings.Index(text, placeholderPrefix)
		if i < 0 {
			break
		}
		rest := text[i+len(placeholderPrefix):]
		j := strings.Index(rest, placeholderSuffix)
		if j < 0 {
			break
		}
		name := rest[:j]
		sec, ok := s.lookup(name)
		if !ok || !matchAny(sec.Hosts, host, nil) {
			return "", fmt.Errorf("%w: %q for %q", ErrSecretNotPermitted, name, host)
		}
		b.WriteString(text[:i])
		b.WriteString(sec.Value)
		text = rest[j+len(placeholderSuffix):]
	}
	b.WriteString(text)
	return b.String(), nil
}

func (s *Secrets) lookup(name string) (Secret, bool) {
	for _, sec := range s.list {
		if sec.Name == name {
			return sec, true
		}
	}
	return Secret{}, false
}

// Values returns every real value, for the output masker.
func (s *Secrets) Values() []string {
	out := make([]string, 0, len(s.list))
	for _, sec := range s.list {
		out = append(out, sec.Value)
	}
	return out
}
