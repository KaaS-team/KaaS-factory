// Ported from block/goose@910d084 crates/goose/src/recipe/validate_recipe.rs
package packs

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"

	"gopkg.in/yaml.v3"
)

// Caps on a manifest, ported from goose's recipe validation.
const (
	MaxParams        = 32
	MaxSelectOptions = 200
	MaxParamsBytes   = 128 * 1024
	// MaxManifestBytes bounds how much of a manifest file is read.
	MaxManifestBytes = 1 << 20
)

// Param is one input a pack takes.
type Param struct {
	Key         string   `yaml:"key"`
	Type        string   `yaml:"type,omitempty"`
	Description string   `yaml:"description,omitempty"`
	Options     []string `yaml:"options,omitempty"`
	Default     string   `yaml:"default,omitempty"`
}

// Manifest is a pack.yaml. Keys it does not name (command, gate and so on) are left to the pack's kind.
type Manifest struct {
	Name     string   `yaml:"name"`
	Kind     Kind     `yaml:"kind"`
	Params   []Param  `yaml:"params,omitempty"`
	Retry    *Retry   `yaml:"retry,omitempty"`
	Paths    []string `yaml:"paths,omitempty"`
	Keywords []string `yaml:"keywords,omitempty"`
}

// ParseManifest decodes src and applies every manifest rule.
func ParseManifest(src []byte) (*Manifest, error) {
	var m Manifest
	if err := yaml.Unmarshal(src, &m); err != nil {
		return nil, fmt.Errorf("manifest: %w", err)
	}
	if err := m.Validate(); err != nil {
		return nil, err
	}
	return &m, nil
}

// Validate checks the name, kind, parameter caps, retry block and triggers.
func (m *Manifest) Validate() error {
	if m.Name == "" {
		return fmt.Errorf("manifest: name is required")
	}
	if !m.Kind.Valid() {
		return fmt.Errorf("manifest %s: unknown kind %q", m.Name, m.Kind)
	}
	if err := validateParams(m.Params); err != nil {
		return fmt.Errorf("manifest %s: %w", m.Name, err)
	}
	if m.Retry != nil {
		if err := m.Retry.Validate(); err != nil {
			return fmt.Errorf("manifest %s: invalid retry configuration: %w", m.Name, err)
		}
	}
	if err := validateTriggers(m.Paths, m.Keywords); err != nil {
		return fmt.Errorf("manifest %s: %w", m.Name, err)
	}
	return nil
}

func validateParams(ps []Param) error {
	if len(ps) > MaxParams {
		return fmt.Errorf("%d parameters but the maximum is %d", len(ps), MaxParams)
	}
	opts := 0
	for _, p := range ps {
		opts += len(p.Options)
	}
	if opts > MaxSelectOptions {
		return fmt.Errorf("%d total select options but the maximum is %d", opts, MaxSelectOptions)
	}
	b, err := yaml.Marshal(ps)
	if err != nil {
		return err
	}
	if len(b) > MaxParamsBytes {
		return fmt.Errorf("serialized parameters exceed the %d KiB limit", MaxParamsBytes/1024)
	}
	return nil
}

// LoadManifest reads path (at most MaxManifestBytes), validates it, and fails with ErrHashMismatch when
// wantSHA256 is set and differs from the file's hash, or when the file changed while it was validated.
func LoadManifest(path, wantSHA256 string) (*Manifest, error) {
	return loadManifest(path, wantSHA256, func() {})
}

func loadManifest(path, wantSHA256 string, afterValidate func()) (*Manifest, error) {
	first, err := readBounded(path)
	if err != nil {
		return nil, err
	}
	if wantSHA256 != "" {
		if got := digest(first); got != wantSHA256 {
			return nil, fmt.Errorf("%s: %w: lock has %s, file has %s", path, ErrHashMismatch, wantSHA256, got)
		}
	}
	m, err := ParseManifest(first)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	afterValidate()
	again, err := readBounded(path)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(first, again) {
		return nil, fmt.Errorf("%s: file changed after validation", path)
	}
	return m, nil
}

func readBounded(path string) ([]byte, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, MaxManifestBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > MaxManifestBytes {
		return nil, fmt.Errorf("%s: larger than %d bytes", path, MaxManifestBytes)
	}
	return b, nil
}

func digest(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
