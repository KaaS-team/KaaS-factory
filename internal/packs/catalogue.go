package packs

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// maxPackBytes caps one downloaded pack file.
const maxPackBytes = 8 << 20

// ErrCatalogueSignature means the catalogue bytes do not match their signature.
var ErrCatalogueSignature = errors.New("catalogue signature does not verify")

// ErrPackHash means downloaded pack bytes do not match the catalogue sha256.
var ErrPackHash = errors.New("pack sha256 does not match the catalogue")

// CatalogueEntry is one installable pack. The field names follow the blueprint catalogue, so
// catalogue/catalogue.json is accepted as is. Version and URL are optional there: the version
// defaults to the commit after "@" in Source, and the URL is built from Source.
type CatalogueEntry struct {
	ID      string `json:"id"`
	Name    string `json:"name,omitempty"`
	Kind    string `json:"kind,omitempty"`
	Version string `json:"version,omitempty"`
	Source  string `json:"source,omitempty"`
	URL     string `json:"url,omitempty"`
	Licence string `json:"licence,omitempty"`
	SHA256  string `json:"sha256"`
}

// PackName is the name the entry installs under.
func (e CatalogueEntry) PackName() string {
	if e.Name != "" {
		return e.Name
	}
	return e.ID
}

// PackVersion is the explicit version, else the commit named in Source.
func (e CatalogueEntry) PackVersion() string {
	if e.Version != "" {
		return e.Version
	}
	if _, rest, ok := strings.Cut(e.Source, "@"); ok {
		v, _, _ := strings.Cut(rest, "#")
		return v
	}
	return ""
}

// PackURL is the explicit URL, else the raw GitHub URL for Source (owner/repo@sha#path; a bare repo is KaaS-team/repo).
func (e CatalogueEntry) PackURL() (string, error) {
	if e.URL != "" {
		return e.URL, nil
	}
	head, p, ok := strings.Cut(e.Source, "#")
	slug, sha, ok2 := strings.Cut(head, "@")
	if !ok || !ok2 || p == "" || sha == "" {
		return "", fmt.Errorf("%s: no url and source %q is not repo@sha#path", e.PackName(), e.Source)
	}
	if !strings.Contains(slug, "/") {
		slug = "KaaS-team/" + slug
	}
	return "https://raw.githubusercontent.com/" + slug + "/" + sha + "/" + p, nil
}

// Catalogue is a parsed catalogue.
type Catalogue struct{ Entries []CatalogueEntry }

// ParseCatalogue accepts a JSON array of entries (the blueprint shape) or {"packs":[...]}.
func ParseCatalogue(b []byte) (*Catalogue, error) {
	var list []CatalogueEntry
	if err := json.Unmarshal(b, &list); err != nil {
		var wrap struct {
			Packs []CatalogueEntry `json:"packs"`
		}
		if err2 := json.Unmarshal(b, &wrap); err2 != nil {
			return nil, fmt.Errorf("catalogue: %w", err)
		}
		list = wrap.Packs
	}
	for _, e := range list {
		if e.PackName() == "" || e.PackVersion() == "" {
			return nil, fmt.Errorf("catalogue: entry %q needs a name and a version", e.PackName())
		}
		if strings.ContainsAny(e.PackName()+e.PackVersion(), `/\`) || strings.Contains(e.PackName()+e.PackVersion(), "..") {
			return nil, fmt.Errorf("catalogue: entry %q has an unsafe name or version", e.PackName())
		}
		if len(e.SHA256) != 64 {
			return nil, fmt.Errorf("catalogue: entry %q needs a 64 character sha256", e.PackName())
		}
	}
	return &Catalogue{Entries: list}, nil
}

// Find returns the entry for name and version. An empty version matches only when the name is listed once.
func (c *Catalogue) Find(name, version string) (CatalogueEntry, error) {
	var hits []CatalogueEntry
	for _, e := range c.Entries {
		if e.PackName() == name && (version == "" || e.PackVersion() == version) {
			hits = append(hits, e)
		}
	}
	switch len(hits) {
	case 0:
		return CatalogueEntry{}, fmt.Errorf("pack %s@%s is not in the catalogue", name, version)
	case 1:
		return hits[0], nil
	}
	return CatalogueEntry{}, fmt.Errorf("pack %s has %d versions, name one with %s@<version>", name, len(hits), name)
}

// VerifyCatalogue returns the parsed catalogue only when sig (base64 ed25519 over data) verifies against pub.
func VerifyCatalogue(data, sig []byte, pub ed25519.PublicKey) (*Catalogue, error) {
	if len(pub) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("no public key configured, refusing an unsigned catalogue")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(sig)))
	if err != nil {
		return nil, fmt.Errorf("catalogue signature is not base64: %w", err)
	}
	if !ed25519.Verify(pub, data, raw) {
		return nil, ErrCatalogueSignature
	}
	return ParseCatalogue(data)
}

// ParsePublicKey reads a base64 ed25519 public key.
func ParsePublicKey(s string) (ed25519.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(s))
	if err != nil || len(raw) != ed25519.PublicKeySize {
		return nil, fmt.Errorf("public key must be %d bytes of base64", ed25519.PublicKeySize)
	}
	return ed25519.PublicKey(raw), nil
}

// Getter downloads a URL.
type Getter interface {
	Get(ctx context.Context, url string) ([]byte, error)
}

// HTTPGetter is the Getter over net/http.
type HTTPGetter struct{ Client *http.Client }

// Get fetches url and fails on any status but 200.
func (h HTTPGetter) Get(ctx context.Context, url string) ([]byte, error) {
	c := h.Client
	if c == nil {
		c = &http.Client{Timeout: 60 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("get %s: status %d", url, resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxPackBytes+1))
	if err != nil {
		return nil, err
	}
	if len(b) > maxPackBytes {
		return nil, fmt.Errorf("get %s: larger than %d bytes", url, maxPackBytes)
	}
	return b, nil
}

// InstallResult says what Install did.
type InstallResult struct {
	Name, Version, Path string
	AlreadyInstalled    bool
}

// PackDir is where a pack version installs under root.
func PackDir(root, name, version string) string {
	return filepath.Join(root, ".factory", "packs", name, version)
}

// Install downloads the entry, refuses it unless its sha256 matches the catalogue, and writes it to
// PackDir. Nothing is written on a mismatch. A second install of the same bytes changes nothing.
func Install(ctx context.Context, g Getter, root string, e CatalogueEntry) (InstallResult, error) {
	res := InstallResult{Name: e.PackName(), Version: e.PackVersion()}
	url, err := e.PackURL()
	if err != nil {
		return res, err
	}
	base := path.Base(strings.SplitN(url, "?", 2)[0])
	if base == "" || base == "." || base == "/" {
		return res, fmt.Errorf("%s: cannot name a file from %s", res.Name, url)
	}
	res.Path = filepath.Join(PackDir(root, res.Name, res.Version), base)
	if have, err := os.ReadFile(res.Path); err == nil && hashHex(have) == e.SHA256 {
		res.AlreadyInstalled = true
		return res, nil
	}
	body, err := g.Get(ctx, url)
	if err != nil {
		return res, err
	}
	if got := hashHex(body); got != e.SHA256 {
		return res, fmt.Errorf("%s@%s: %w: catalogue has %s, download has %s", res.Name, res.Version, ErrPackHash, e.SHA256, got)
	}
	if err := os.MkdirAll(filepath.Dir(res.Path), 0o755); err != nil {
		return res, err
	}
	tmp := res.Path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o644); err != nil {
		return res, err
	}
	return res, os.Rename(tmp, res.Path)
}

func hashHex(b []byte) string {
	s := sha256.Sum256(b)
	return hex.EncodeToString(s[:])
}
