package gitx

import (
	"context"
	"fmt"
	"path"
	"strings"
)

// secretPatterns are base-name globs of files an agent must never commit. A match is refused
// unless it is in secretAllowed.
var (
	secretPatterns = []string{".env", ".env.*", "*.pem", "*.key", "id_rsa*", "*.p12", "credentials*.json", ".npmrc", ".netrc"}
	secretAllowed  = []string{".env.example"}
)

// IsSecretPath reports whether p names a file that looks like a secret.
func IsSecretPath(p string) bool {
	base := path.Base(strings.ReplaceAll(p, "\\", "/"))
	for _, a := range secretAllowed {
		if base == a {
			return false
		}
	}
	for _, pat := range secretPatterns {
		if ok, _ := path.Match(pat, base); ok {
			return true
		}
	}
	return false
}

// StageAll runs `git add -A` in dir, then unstages and refuses every staged path that looks like a
// secret. It is the one way an agent worktree is staged. run executes git in dir and returns stdout.
func StageAll(ctx context.Context, run func(ctx context.Context, args ...string) (string, error)) error {
	if _, err := run(ctx, "add", "-A"); err != nil {
		return err
	}
	out, err := run(ctx, "diff", "--cached", "--name-only", "-z")
	if err != nil {
		return err
	}
	var bad []string
	for _, p := range strings.Split(out, "\x00") {
		if p != "" && IsSecretPath(p) {
			bad = append(bad, p)
		}
	}
	if len(bad) == 0 {
		return nil
	}
	if _, err := run(ctx, append([]string{"reset", "-q", "--"}, bad...)...); err != nil {
		return err
	}
	return fmt.Errorf("gitx: refusing to stage secret-looking files: %s", strings.Join(bad, ", "))
}
