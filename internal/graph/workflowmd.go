package graph

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// importKeys are the front matter keys an imported file may use.
var importKeys = map[string]bool{"imports": true, "safe_outputs": true}

// imported is one expanded import: its body and the safe outputs it lists.
type imported struct {
	body string
	safe []WriteKind
}

// expandImports resolves the imports of the workflow file at path in topological order, dependencies
// first, each file once. A cycle is an error naming the whole path (a -> b -> c -> a).
func expandImports(path string, front *yaml.Node) ([]imported, error) {
	root := filepath.Dir(path)
	var out []imported
	done := map[string]bool{}
	var visit func(from string, list *yaml.Node, stack []string) error
	visit = func(from string, list *yaml.Node, stack []string) error {
		if list.Kind != yaml.SequenceNode {
			return fmt.Errorf("imports must be a list of file paths")
		}
		for _, it := range list.Content {
			rel := filepath.Join(filepath.Dir(from), it.Value)
			if it.Kind != yaml.ScalarNode || !filepath.IsLocal(it.Value) {
				return fmt.Errorf("import %q must be a relative path inside its own directory", it.Value)
			}
			for i, s := range stack {
				if s == rel {
					return fmt.Errorf("import cycle: %s", strings.Join(append(stack[i:len(stack):len(stack)], rel), " -> "))
				}
			}
			if done[rel] {
				continue
			}
			data, err := os.ReadFile(filepath.Join(root, rel))
			if err != nil {
				return fmt.Errorf("import %s: %w", rel, err)
			}
			fm, body, _, err := splitFrontMatter(string(data))
			if err != nil {
				return fmt.Errorf("import %s: %w", rel, err)
			}
			var n yaml.Node
			if err := yaml.Unmarshal([]byte(fm), &n); err != nil {
				return fmt.Errorf("import %s: workflow_parse_error: %w", rel, err)
			}
			imp := imported{body: strings.TrimSpace(body)}
			var sub *yaml.Node
			if len(n.Content) > 0 {
				m := n.Content[0]
				if m.Kind != yaml.MappingNode {
					return fmt.Errorf("import %s: workflow_front_matter_not_a_map", rel)
				}
				for i := 0; i+1 < len(m.Content); i += 2 {
					if k := m.Content[i].Value; !importKeys[k] {
						return fmt.Errorf("import %s: key %q is not allowed in an imported file%s", rel, k, suggest(k, importKeys))
					}
				}
				sub = child(m, "imports")
				if v := child(m, "safe_outputs"); v != nil {
					if imp.safe, err = parseSafeOutputs(v); err != nil {
						return fmt.Errorf("import %s: %w", rel, err)
					}
				}
			}
			if err := checkMarkdownVars(imp.body, 0); err != nil {
				return fmt.Errorf("import %s: %w", rel, err)
			}
			if _, err := parseTemplate(imp.body); err != nil {
				return fmt.Errorf("import %s: %w", rel, err)
			}
			if sub != nil {
				if err := visit(rel, sub, append(stack[:len(stack):len(stack)], rel)); err != nil {
					return err
				}
			}
			done[rel] = true
			out = append(out, imp)
		}
		return nil
	}
	self, err := filepath.Rel(root, path)
	if err != nil {
		return nil, err
	}
	if err := visit(self, front, []string{self}); err != nil {
		return nil, err
	}
	return out, nil
}

// CanonicalHash returns the sha256 of the sorted-key canonical JSON of v and body, as hex. Map keys are
// sorted at every depth, so key order in the file does not change it.
func CanonicalHash(v any, body string) string {
	b, err := json.Marshal(map[string]any{"front": v, "body": body})
	if err != nil { // front matter decoded from YAML, so only a non-string map key can fail
		b = []byte(fmt.Sprintf("%v|%s", v, body))
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// frontHash is CanonicalHash of a YAML front matter node, or of nothing when m is nil.
func frontHash(m *yaml.Node, body string) string {
	var v any
	if m != nil {
		_ = m.Decode(&v)
	}
	return CanonicalHash(v, body)
}

// editDistance is the Levenshtein distance between a and b.
func editDistance(a, b string) int {
	ra, rb := []rune(a), []rune(b)
	prev := make([]int, len(rb)+1)
	for j := range prev {
		prev[j] = j
	}
	for i := 1; i <= len(ra); i++ {
		cur := make([]int, len(rb)+1)
		cur[0] = i
		for j := 1; j <= len(rb); j++ {
			cost := 1
			if ra[i-1] == rb[j-1] {
				cost = 0
			}
			cur[j] = min(prev[j]+1, cur[j-1]+1, prev[j-1]+cost)
		}
		prev = cur
	}
	return prev[len(rb)]
}

// suggest returns `; did you mean "x"?` for the nearest allowed key within two edits, else "".
func suggest(got string, allowed map[string]bool) string {
	best, bd := "", 3
	for k := range allowed {
		if d := editDistance(got, k); d < bd || (d == bd && k < best) {
			best, bd = k, d
		}
	}
	if best == "" {
		return ""
	}
	return fmt.Sprintf("; did you mean %q?", best)
}

// checkNoWriteCredential refuses a write credential on an agent: a name ending in :write, or one that
// is a bare token, key or secret name. Agents write only through safe outputs.
func checkNoWriteCredential(where string, creds []string) error {
	for _, c := range creds {
		u := strings.ToUpper(c)
		if strings.HasSuffix(c, ":write") || strings.Contains(u, "TOKEN") || strings.Contains(u, "SECRET") || strings.HasSuffix(u, "_KEY") {
			return fmt.Errorf("%s asks for write credential %q; an agent writes only through safe_outputs", where, c)
		}
	}
	return nil
}
