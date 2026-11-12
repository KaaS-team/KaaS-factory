package packs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func params(n int, opts int) string {
	var b strings.Builder
	b.WriteString("name: p\nkind: skill\nparams:\n")
	for i := 0; i < n; i++ {
		b.WriteString("  - key: k" + string(rune('a'+i%26)) + strings.Repeat("x", i) + "\n    type: select\n    options: [")
		for j := 0; j < opts; j++ {
			if j > 0 {
				b.WriteString(",")
			}
			b.WriteString("o")
		}
		b.WriteString("]\n")
	}
	return b.String()
}

func TestParseManifestCaps(t *testing.T) {
	big := "name: p\nkind: skill\nparams:\n  - key: a\n    description: " + strings.Repeat("x", MaxParamsBytes) + "\n"
	tests := []struct {
		name, src, want string
	}{
		{"at the param cap", params(MaxParams, 1), ""},
		{"over the param cap", params(MaxParams+1, 1), "maximum is 32"},
		{"at the option cap", params(1, MaxSelectOptions), ""},
		{"over the option cap", params(1, MaxSelectOptions+1), "maximum is 200"},
		{"options add up across params", params(2, MaxSelectOptions/2+1), "maximum is 200"},
		{"over the size cap", big, "128 KiB"},
		{"no params", "name: p\nkind: skill\n", ""},
		{"unknown kind", "name: p\nkind: nope\n", "unknown kind"},
		{"no name", "kind: skill\n", "name"},
		{"not yaml", "name: [", "manifest"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseManifest([]byte(tc.src))
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestLoadManifestLockHash(t *testing.T) {
	src := []byte("name: p\nkind: skill\n")
	path := filepath.Join(t.TempDir(), "pack.yaml")
	if err := os.WriteFile(path, src, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(src)
	good := hex.EncodeToString(sum[:])
	if _, err := LoadManifest(path, good); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest(path, ""); err != nil {
		t.Fatalf("no lock hash: %v", err)
	}
	if _, err := LoadManifest(path, strings.Repeat("0", 64)); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("err = %v, want ErrHashMismatch", err)
	}
}

func TestLoadManifestBoundedRead(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pack.yaml")
	if err := os.WriteFile(path, []byte("name: p\nkind: skill\n# "+strings.Repeat("x", MaxManifestBytes)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadManifest(path, ""); err == nil || !strings.Contains(err.Error(), "larger than") {
		t.Fatalf("err = %v", err)
	}
}

func TestLoadManifestFailsWhenFileChangesAfterValidation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pack.yaml")
	if err := os.WriteFile(path, []byte("name: p\nkind: skill\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	change := func() { _ = os.WriteFile(path, []byte("name: q\nkind: skill\n"), 0o644) }
	if _, err := loadManifest(path, "", change); err == nil || !strings.Contains(err.Error(), "changed") {
		t.Fatalf("err = %v, want a changed-file error", err)
	}
}
