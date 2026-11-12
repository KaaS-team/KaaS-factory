package broker

import (
	"context"
	"fmt"
	"os"
	"strings"
)

// FileSource reads the secret from a file path on each call, so rotation needs no restart.
type FileSource string

// Secret returns the trimmed file contents. It refuses a file readable by group or others.
func (f FileSource) Secret(context.Context) (string, error) {
	fi, err := os.Stat(string(f))
	if err != nil {
		return "", fmt.Errorf("broker: secret file: %w", err)
	}
	if fi.Mode().Perm()&0o077 != 0 {
		return "", fmt.Errorf("broker: secret file %s must not be readable by group or others", f)
	}
	b, err := os.ReadFile(string(f))
	if err != nil {
		return "", fmt.Errorf("broker: secret file: %w", err)
	}
	s := strings.TrimSpace(string(b))
	if s == "" {
		return "", fmt.Errorf("broker: secret file %s is empty", f)
	}
	return s, nil
}
