// Ported from e2b-dev/E2B@3e72be3 packages/js-sdk/src/sandbox/iam.ts

package egress

import (
	"fmt"
	"strings"
	"unicode"
)

// ValidateTokenName rejects a secret name that cannot survive the placeholder
// grammar. The proxy reads a placeholder as everything between the prefix and
// the next "}", so a "}" in a name ends it early (and resolves an unrelated
// secret), and a "{" lets a name open a second placeholder the caller never
// wrote. Control characters cannot appear in an HTTP header value at all.
func ValidateTokenName(name string) error {
	if name == "" || strings.ContainsFunc(name, func(r rune) bool {
		return r == '{' || r == '}' || unicode.Is(unicode.Cc, r)
	}) {
		return fmt.Errorf("secret name %q is not usable: it cannot be empty or contain '{', '}' or control characters, because it is interpolated into the %q placeholder the egress proxy resolves", name, placeholderPrefix+"<name>"+placeholderSuffix)
	}
	return nil
}
