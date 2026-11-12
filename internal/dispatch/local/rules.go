// Ported from sst/opencode@a1aa513 packages/core/src/permission.ts (evaluate, Unattended) and packages/core/src/util/wildcard.ts

package local

import (
	"regexp"
	"strings"
)

// Rule is one permission line: an action, a resource glob and allow, deny or ask.
type Rule struct{ Action, Resource, Effect string }

var globEscape = strings.NewReplacer(`\`, "/", ".", `\.`, "+", `\+`, "^", `\^`, "$", `\$`, "{", `\{`, "}", `\}`,
	"(", `\(`, ")", `\)`, "|", `\|`, "[", `\[`, "]", `\]`)

// match reports whether input fits the glob: * is any run, ? one character, a
// trailing " *" also matches the bare command.
func match(input, pattern string) bool {
	p := strings.ReplaceAll(strings.ReplaceAll(globEscape.Replace(pattern), "*", ".*"), "?", ".")
	if strings.HasSuffix(p, " .*") {
		p = strings.TrimSuffix(p, " .*") + "( .*)?"
	}
	ok, err := regexp.MatchString("(?s)^"+p+"$", strings.ReplaceAll(input, `\`, "/"))
	return err == nil && ok
}

// Evaluate returns the last rule across the sets that matches, or an ask rule when none does.
func Evaluate(action, resource string, sets ...[]Rule) Rule {
	found := Rule{action, "*", "ask"}
	for _, set := range sets {
		for _, r := range set {
			if match(action, r.Action) && match(resource, r.Resource) {
				found = r
			}
		}
	}
	return found
}

// Settle decides a request for every resource. A configured deny wins. A request
// the configured rules leave open stays "ask" when unattended is nil; otherwise it
// is allowed only if the unattended rules allow every resource, and denied if not.
func Settle(action string, resources []string, configured, unattended []Rule) string {
	open := false
	for _, res := range resources {
		switch Evaluate(action, res, configured).Effect {
		case "deny":
			return "deny"
		case "ask":
			open = true
		}
	}
	if !open {
		return "allow"
	}
	if unattended == nil {
		return "ask"
	}
	for _, res := range resources {
		if Evaluate(action, res, configured, unattended).Effect != "allow" {
			return "deny"
		}
	}
	return "allow"
}
