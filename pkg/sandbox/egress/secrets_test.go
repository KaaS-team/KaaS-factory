package egress

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"testing"
)

// Cases follow the rationale in e2b's iam.ts: a brace or control character in
// a name breaks the placeholder grammar. Upstream has no direct test for the
// validator, so each row below is one clause of its doc comment.
func TestValidateTokenName(t *testing.T) {
	cases := []struct {
		name string
		in   string
		ok   bool
	}{
		{"plain", "aws", true},
		{"dots and dashes", "aws.prod-1", true},
		{"unicode letters", "clé", true},
		{"empty", "", false},
		{"close brace ends the placeholder early", "a}b", false},
		{"open brace mints another placeholder", "a{b", false},
		{"nested placeholder", "x${y}", false},
		{"tab", "a\tb", false},
		{"newline", "a\nb", false},
		{"nul", "a\x00b", false},
		{"del", "a\x7fb", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := ValidateTokenName(c.in); (err == nil) != c.ok {
				t.Fatalf("ValidateTokenName(%q) = %v, ok want %v", c.in, err, c.ok)
			}
		})
	}
}

func TestPlaceholder(t *testing.T) {
	if got, _ := Placeholder("aws"); got != "${kaas.secret.aws}" {
		t.Fatalf("got %q", got)
	}
	if _, err := Placeholder("a}b"); err == nil {
		t.Fatal("invalid name must not yield a placeholder")
	}
}

func TestNewSecretsGate(t *testing.T) {
	ok := Secret{Name: "GH_TOKEN", Value: "v", Hosts: []string{"api.github.com"}}
	cases := []struct {
		name string
		min  int
		s    []Secret
		ok   bool
	}{
		{"exact host", 2, []Secret{ok}, true},
		{"wildcard at the depth", 2, []Secret{{Name: "A", Value: "v", Hosts: []string{"*.github.com"}}}, true},
		{"wildcard broader than depth", 2, []Secret{{Name: "A", Value: "v", Hosts: []string{"*.com"}}}, false},
		{"deeper required", 3, []Secret{{Name: "A", Value: "v", Hosts: []string{"*.github.com"}}}, false},
		{"deeper required, met", 3, []Secret{{Name: "A", Value: "v", Hosts: []string{"*.api.github.com"}}}, true},
		{"bare star", 2, []Secret{{Name: "A", Value: "v", Hosts: []string{"*"}}}, false},
		{"mid wildcard", 2, []Secret{{Name: "A", Value: "v", Hosts: []string{"a.*.com"}}}, false},
		{"no hosts", 2, []Secret{{Name: "A", Value: "v"}}, false},
		{"ip host", 2, []Secret{{Name: "A", Value: "v", Hosts: []string{"1.2.3.4"}}}, false},
		{"cidr host", 2, []Secret{{Name: "A", Value: "v", Hosts: []string{"10.0.0.0/8"}}}, false},
		{"empty value", 2, []Secret{{Name: "A", Hosts: []string{"a.com"}}}, false},
		{"brace in name", 2, []Secret{{Name: "A}", Value: "v", Hosts: []string{"a.com"}}}, false},
		{"name not an env var", 2, []Secret{{Name: "a-b", Value: "v", Hosts: []string{"a.com"}}}, false},
		{"duplicate name", 2, []Secret{ok, ok}, false},
		{"none", 2, nil, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, err := NewSecrets(c.min, c.s...)
			if (err == nil) != c.ok {
				t.Fatalf("err = %v, ok want %v", err, c.ok)
			}
		})
	}
}

func mustSecrets(t *testing.T) *Secrets {
	t.Helper()
	s, err := NewSecrets(DefaultMinWildcardLabels,
		Secret{Name: "GH_TOKEN", Value: "ghp_real", Hosts: []string{"api.github.com"}},
		Secret{Name: "NPM_TOKEN", Value: "npm_real", Hosts: []string{"*.npmjs.org"}},
	)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestEnvOnlyCarriesPlaceholdersNamedInTheCommand(t *testing.T) {
	s := mustSecrets(t)
	cases := []struct {
		name, cmd string
		want      []string
	}{
		{"named", `curl -H "x: $GH_TOKEN" https://api.github.com`, []string{"GH_TOKEN=${kaas.secret.GH_TOKEN}"}},
		{"both", "echo $GH_TOKEN $NPM_TOKEN", []string{"GH_TOKEN=${kaas.secret.GH_TOKEN}", "NPM_TOKEN=${kaas.secret.NPM_TOKEN}"}},
		{"not named", "ls -la", nil},
		{"substring is not a name", "echo MY_GH_TOKEN_X", nil},
		{"empty command", "", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := s.Env(c.cmd)
			if strings.Join(got, "|") != strings.Join(c.want, "|") {
				t.Fatalf("Env = %v, want %v", got, c.want)
			}
			for _, e := range got {
				if strings.Contains(e, "ghp_real") || strings.Contains(e, "npm_real") {
					t.Fatalf("real value in env: %q", e)
				}
			}
		})
	}
}

func TestExpand(t *testing.T) {
	s := mustSecrets(t)
	cases := []struct {
		name, host, in, want string
		err                  error
	}{
		{"allowed host", "api.github.com", "Bearer ${kaas.secret.GH_TOKEN}", "Bearer ghp_real", nil},
		{"host case and dot", "API.github.com.", "${kaas.secret.GH_TOKEN}", "ghp_real", nil},
		{"wildcard host", "registry.npmjs.org", "${kaas.secret.NPM_TOKEN}", "npm_real", nil},
		{"two in one", "api.github.com", "${kaas.secret.GH_TOKEN}:${kaas.secret.GH_TOKEN}", "ghp_real:ghp_real", nil},
		{"no placeholder passes through", "evil.example", "plain text", "plain text", nil},
		{"hostile host", "evil.example", "${kaas.secret.GH_TOKEN}", "", ErrSecretNotPermitted},
		{"right secret wrong host", "api.github.com", "${kaas.secret.NPM_TOKEN}", "", ErrSecretNotPermitted},
		{"wildcard skips apex", "npmjs.org", "${kaas.secret.NPM_TOKEN}", "", ErrSecretNotPermitted},
		{"lookalike suffix", "api.github.com.evil.example", "${kaas.secret.GH_TOKEN}", "", ErrSecretNotPermitted},
		{"unknown name", "api.github.com", "${kaas.secret.NOPE}", "", ErrSecretNotPermitted},
		{"unterminated stays literal", "api.github.com", "${kaas.secret.GH_TOKEN", "${kaas.secret.GH_TOKEN", nil},
		{"value is not re-expanded", "api.github.com", "${kaas.secret.GH_TOKEN}", "ghp_real", nil},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := s.Expand(c.host, c.in)
			if !errors.Is(err, c.err) {
				t.Fatalf("err = %v, want %v", err, c.err)
			}
			if got != c.want {
				t.Fatalf("got %q, want %q", got, c.want)
			}
		})
	}
}

func TestExpandDoesNotReexpandValues(t *testing.T) {
	s, err := NewSecrets(2,
		Secret{Name: "A", Value: "${kaas.secret.B}", Hosts: []string{"a.com"}},
		Secret{Name: "B", Value: "bee", Hosts: []string{"a.com"}})
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.Expand("a.com", "${kaas.secret.A}")
	if got != "${kaas.secret.B}" {
		t.Fatalf("got %q", got)
	}
}

func TestAppliesTo(t *testing.T) {
	s := mustSecrets(t)
	for host, want := range map[string]bool{"api.github.com": true, "x.npmjs.org": true, "npmjs.org": false, "other.com": false} {
		if got := s.AppliesTo(host); got != want {
			t.Errorf("AppliesTo(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestSecretNeverPrintsItsValue(t *testing.T) {
	sec := Secret{Name: "GH_TOKEN", Value: "ghp_real_value", Hosts: []string{"a.com"}}
	set, _ := NewSecrets(2, sec)
	var sb strings.Builder
	slog.New(slog.NewJSONHandler(&sb, nil)).Info("s", "secret", sec, "ptr", &sec)
	j, _ := json.Marshal(sec)
	for _, out := range []string{
		fmt.Sprint(sec), fmt.Sprintf("%v %+v %#v %s", sec, sec, sec, sec), fmt.Sprintf("%+v %#v", &sec, &sec), fmt.Sprintf("%v %+v %#v", set, set, set), fmt.Sprintf("%+v", struct{ S *Secrets }{set}),
		sb.String(), string(j),
	} {
		if strings.Contains(out, "ghp_real_value") {
			t.Fatalf("value leaked: %s", out)
		}
	}
}
