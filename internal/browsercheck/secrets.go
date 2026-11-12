// Ported from browser-use/browser-use@dfb6a73 browser_use/repl/session.py
package browsercheck

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"net/url"
	"os"
	"slices"
	"strings"
	"unicode"

	"gopkg.in/yaml.v3"
)

// Secret is a named value a step may type without the value ever being printed.
type Secret struct {
	Name   string
	Value  string
	Domain string // when set, the value types only on this host or a subdomain of it
}

// Secrets is the set a run may type from.
type Secrets []Secret

// shortSecret is the length below which a form is redacted only as a whole word.
const shortSecret = 4

// LoadSecrets reads a YAML map of name to value, or name to {value, domain}.
func LoadSecrets(path string) (Secrets, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("secrets: %w", err)
	}
	var doc yaml.Node
	if err := yaml.Unmarshal(data, &doc); err != nil || len(doc.Content) == 0 || doc.Content[0].Kind != yaml.MappingNode {
		return nil, errors.New("secrets: want a YAML map of name to value")
	}
	m := doc.Content[0].Content
	var out Secrets
	for i := 0; i+1 < len(m); i += 2 {
		s := Secret{Name: m[i].Value}
		var f struct {
			Value  string `yaml:"value"`
			Domain string `yaml:"domain"`
		}
		if m[i+1].Kind == yaml.ScalarNode {
			s.Value = m[i+1].Value
		} else if err := m[i+1].Decode(&f); err != nil {
			return nil, fmt.Errorf("secrets: %s: %w", s.Name, err)
		} else {
			s.Value, s.Domain = f.Value, f.Domain
		}
		if s.Value == "" {
			return nil, fmt.Errorf("secrets: %s has no value", s.Name)
		}
		out = append(out, s)
	}
	return out, nil
}

// Names lists the secret names, sorted. The model and the logs see these, never a value.
func (s Secrets) Names() []string {
	var n []string
	for _, x := range s {
		n = append(n, x.Name)
	}
	slices.Sort(n)
	return n
}

// Lookup returns the value of the secret called name for a page on host. A scoped secret fails
// closed when host is empty or outside its domain. Errors name secrets, never values.
func (s Secrets) Lookup(name, host string) (string, error) {
	for _, x := range s {
		if x.Name != name {
			continue
		}
		d := strings.TrimPrefix(x.Domain, "*.")
		if d != "" && (host == "" || (host != d && !strings.HasSuffix(host, "."+d))) {
			return "", fmt.Errorf("secret %q is scoped to domain %s and the page is not on it", name, d)
		}
		return x.Value, nil
	}
	return "", fmt.Errorf("no secret named %q (known: %s)", name, strings.Join(s.Names(), ", "))
}

// Redact replaces every secret value, and common encodings of it, with <secret:name>. It covers
// the text passed in; it is not a sandbox.
func (s Secrets) Redact(text string) string {
	type form struct{ text, name string }
	var forms []form
	seen := map[string]bool{}
	add := func(name string, fs ...string) {
		for _, f := range fs {
			if f != "" && !seen[f] {
				seen[f] = true
				forms = append(forms, form{f, name})
			}
		}
	}
	for _, x := range s {
		v := x.Value
		add(x.Name, v, jsonForm(v, true), jsonForm(v, false), html.EscapeString(v), strings.ToLower(v), strings.ToUpper(v))
		if len([]rune(v)) >= shortSecret {
			b := []byte(v)
			add(x.Name, reverse(v), base64.StdEncoding.EncodeToString(b), base64.RawStdEncoding.EncodeToString(b),
				base64.URLEncoding.EncodeToString(b), base64.RawURLEncoding.EncodeToString(b), hex.EncodeToString(b),
				strings.ToUpper(hex.EncodeToString(b)), url.QueryEscape(v), strings.ReplaceAll(url.QueryEscape(v), "+", "%20"))
		}
	}
	slices.SortStableFunc(forms, func(a, b form) int { return len(b.text) - len(a.text) })
	for _, f := range forms {
		if len([]rune(f.text)) < shortSecret {
			text = replaceWord(text, f.text, "<secret:"+f.name+">")
		} else {
			text = strings.ReplaceAll(text, f.text, "<secret:"+f.name+">")
		}
	}
	return text
}

func jsonForm(v string, escapeHTML bool) string {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(escapeHTML)
	_ = e.Encode(v)
	return strings.TrimSuffix(strings.TrimSuffix(b.String(), "\n"), `"`)[1:]
}

func reverse(v string) string {
	r := []rune(v)
	slices.Reverse(r)
	return string(r)
}

// replaceWord replaces old only where no letter or digit touches it, so "9" does not turn 2019 into 201<secret>.
func replaceWord(text, old, repl string) string {
	var out strings.Builder
	for {
		i := strings.Index(text, old)
		if i < 0 {
			break
		}
		before, after := []rune(text[:i]), []rune(text[i+len(old):])
		out.WriteString(text[:i])
		if (len(before) > 0 && alnum(before[len(before)-1])) || (len(after) > 0 && alnum(after[0])) {
			out.WriteString(old)
		} else {
			out.WriteString(repl)
		}
		text = text[i+len(old):]
	}
	out.WriteString(text)
	return out.String()
}

func alnum(r rune) bool { return unicode.IsLetter(r) || unicode.IsDigit(r) }
