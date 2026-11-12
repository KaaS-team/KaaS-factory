// Package selfupdate checks for a newer factory release and replaces the
// running binary after verifying the release asset against its checksum.
package selfupdate

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

const (
	defaultAPIBase     = "https://api.github.com/repos/KaaS-team/factory"
	defaultReleaseBase = "https://github.com/KaaS-team/factory/releases/download"
	maxMetadataSize    = 1 << 20
	maxArchiveSize     = 100 << 20
	binaryName         = "factory"
	checksumsName      = "checksums.txt"
)

var versionRe = regexp.MustCompile(`^v([0-9]+)\.([0-9]+)\.([0-9]+)([.-][0-9A-Za-z.-]+)?$`)

// Release names one published version.
type Release struct {
	Version string
}

// Source finds the latest release and fetches its files.
type Source interface {
	// Latest returns the newest release.
	Latest(ctx context.Context) (Release, error)
	// Asset returns the bytes of the named file of a release.
	Asset(ctx context.Context, version, name string) ([]byte, error)
}

// Check reports the latest release and whether it is newer than current.
// A current version that is not vMAJOR.MINOR.PATCH counts as older.
func Check(ctx context.Context, current string, src Source) (Release, bool, error) {
	rel, err := src.Latest(ctx)
	if err != nil {
		return Release{}, false, err
	}
	latest, ok := parseVersion(rel.Version)
	if !ok {
		return Release{}, false, fmt.Errorf("invalid release version %q; expected vMAJOR.MINOR.PATCH", rel.Version)
	}
	cur, ok := parseVersion(current)
	if !ok {
		return rel, true, nil
	}
	return rel, compare(latest, cur) > 0, nil
}

func parseVersion(v string) ([3]int, bool) {
	m := versionRe.FindStringSubmatch(v)
	if m == nil {
		return [3]int{}, false
	}
	var out [3]int
	for i := range out {
		out[i], _ = strconv.Atoi(m[i+1])
	}
	return out, true
}

func compare(a, b [3]int) int {
	for i := range a {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}

// AssetName is the archive name of a release for one platform.
func AssetName(version, goos, goarch string) string {
	return fmt.Sprintf("%s_%s_%s_%s.tar.gz", binaryName, strings.TrimPrefix(version, "v"), goos, goarch)
}

// Apply downloads the release archive for goos/goarch (the running platform
// when empty), verifies its sha256 against checksums.txt, and replaces the
// binary at exe through a rename in the same directory. On any failure the
// old binary is left untouched.
func Apply(ctx context.Context, rel Release, src Source, exe, goos, goarch string) error {
	if _, ok := parseVersion(rel.Version); !ok {
		return fmt.Errorf("invalid release version %q", rel.Version)
	}
	if goos == "" {
		goos = runtime.GOOS
	}
	if goarch == "" {
		goarch = runtime.GOARCH
	}
	if goos != "linux" && goos != "darwin" {
		return fmt.Errorf("unsupported operating system %q", goos)
	}
	if goarch != "amd64" && goarch != "arm64" {
		return fmt.Errorf("unsupported architecture %q", goarch)
	}
	if exe == "" {
		p, err := os.Executable()
		if err != nil {
			return fmt.Errorf("find current executable: %w", err)
		}
		exe = p
	}
	name := AssetName(rel.Version, goos, goarch)
	sums, err := src.Asset(ctx, rel.Version, checksumsName)
	if err != nil {
		return fmt.Errorf("download checksums: %w", err)
	}
	want, err := checksumFor(sums, name)
	if err != nil {
		return err
	}
	archive, err := src.Asset(ctx, rel.Version, name)
	if err != nil {
		return fmt.Errorf("download release archive: %w", err)
	}
	got := sha256.Sum256(archive)
	if !strings.EqualFold(hex.EncodeToString(got[:]), want) {
		return fmt.Errorf("checksum mismatch for %s", name)
	}
	bin, err := extractBinary(archive)
	if err != nil {
		return err
	}
	return replaceExecutable(exe, bin)
}

func checksumFor(sums []byte, name string) (string, error) {
	for _, line := range strings.Split(string(sums), "\n") {
		f := strings.Fields(line)
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == name {
			d, err := hex.DecodeString(f[0])
			if err != nil || len(d) != sha256.Size {
				return "", fmt.Errorf("invalid checksum for %s", name)
			}
			return f[0], nil
		}
	}
	return "", fmt.Errorf("%s does not contain %s", checksumsName, name)
}

func extractBinary(archive []byte) ([]byte, error) {
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, fmt.Errorf("open release archive: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil, errors.New("release archive does not contain " + binaryName)
		}
		if err != nil {
			return nil, fmt.Errorf("read release archive: %w", err)
		}
		if h.Name != binaryName || !h.FileInfo().Mode().IsRegular() {
			continue
		}
		if h.Size < 1 || h.Size > maxArchiveSize {
			return nil, errors.New("release archive has an invalid binary size")
		}
		return io.ReadAll(io.LimitReader(tr, maxArchiveSize+1))
	}
}

func replaceExecutable(path string, bin []byte) error {
	resolved, err := filepath.EvalSymlinks(path)
	if err != nil {
		return fmt.Errorf("resolve current executable: %w", err)
	}
	info, err := os.Stat(resolved)
	if err != nil {
		return fmt.Errorf("inspect current executable: %w", err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(resolved), ".factory-update-*")
	if err != nil {
		return fmt.Errorf("create update beside %s: %w", resolved, err)
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	mode := info.Mode().Perm()
	if mode&0o111 == 0 {
		mode = 0o755
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return fmt.Errorf("set update permissions: %w", err)
	}
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		return fmt.Errorf("write update: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("sync update: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close update: %w", err)
	}
	if err := os.Rename(tmpPath, resolved); err != nil {
		return fmt.Errorf("replace %s: %w", resolved, err)
	}
	return nil
}

// GitHubSource reads the releases of KaaS-team/factory on GitHub.
type GitHubSource struct {
	// Client overrides http.DefaultClient.
	Client *http.Client
	// APIBase and ReleaseBase override the GitHub URLs; tests point them at a local server.
	APIBase, ReleaseBase string
}

// Latest asks GitHub for the latest release tag.
func (g GitHubSource) Latest(ctx context.Context) (Release, error) {
	base := g.APIBase
	if base == "" {
		base = defaultAPIBase
	}
	body, err := g.get(ctx, strings.TrimRight(base, "/")+"/releases/latest", maxMetadataSize)
	if err != nil {
		return Release{}, fmt.Errorf("find latest release: %w", err)
	}
	var meta struct {
		TagName string `json:"tag_name"`
	}
	if err := json.Unmarshal(body, &meta); err != nil {
		return Release{}, fmt.Errorf("decode latest release: %w", err)
	}
	return Release{Version: meta.TagName}, nil
}

// Asset downloads one file of a release.
func (g GitHubSource) Asset(ctx context.Context, version, name string) ([]byte, error) {
	base := g.ReleaseBase
	if base == "" {
		base = defaultReleaseBase
	}
	return g.get(ctx, strings.TrimRight(base, "/")+"/"+version+"/"+name, maxArchiveSize)
}

func (g GitHubSource) get(ctx context.Context, url string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "factory-selfupdate")
	c := g.Client
	if c == nil {
		c = http.DefaultClient
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s returned %s", url, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > limit {
		return nil, fmt.Errorf("response from %s exceeds %d bytes", url, limit)
	}
	return body, nil
}
