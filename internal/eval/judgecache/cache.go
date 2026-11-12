// Package judgecache remembers judge verdicts on disk, keyed by a hash of the
// fixture, the output and the rubric version, so an unchanged fixture is not
// judged twice. It never calls a model itself; the wrapped Judge does.
package judgecache

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
)

// Request is one thing to judge.
type Request struct {
	Fixture       string // fixture name or content hash
	Output        string // the agent output being judged
	RubricVersion string // see Version; any edit to the rubric changes it
}

// Verdict is a judge's answer.
type Verdict struct {
	Pass   bool    `json:"pass"`
	Score  float64 `json:"score"`
	Reason string  `json:"reason"`
}

// Result is a verdict and whether it came from the cache.
type Result struct {
	Verdict
	Cached bool `json:"-"`
}

// Judge scores one request. The real implementation makes a model call.
type Judge interface {
	Judge(ctx context.Context, r Request) (Verdict, error)
}

// Cache wraps a Judge with an on-disk verdict store.
type Cache struct {
	dir   string
	inner Judge
}

// New returns a Cache that stores entries under dir and calls inner on a miss.
func New(dir string, inner Judge) *Cache { return &Cache{dir: dir, inner: inner} }

// Version is the rubric version for a rubric text: its sha256 hex.
func Version(rubric string) string { return sum(rubric) }

// Key is the cache key: a hash over the length-prefixed fixture, output and rubric version.
func Key(r Request) string {
	return sum(fmt.Sprintf("%d:%s%d:%s%d:%s", len(r.Fixture), r.Fixture, len(r.Output), r.Output, len(r.RubricVersion), r.RubricVersion))
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

func entryPath(dir string, r Request) string { return filepath.Join(dir, Key(r)+".json") }

func writeFile(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	_, werr := f.Write(b)
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = os.Chmod(tmp, 0o644)
	}
	if werr == nil {
		werr = os.Rename(tmp, path)
	}
	if werr != nil {
		_ = os.Remove(tmp)
	}
	return werr
}

// Judge returns the stored verdict for r, or asks the wrapped judge and stores the answer.
// A missing or unreadable entry is a miss. A judge error is returned and never stored; a failed cache write is logged and the verdict still returned.
func (c *Cache) Judge(ctx context.Context, r Request) (Result, error) {
	p := entryPath(c.dir, r)
	if raw, err := os.ReadFile(p); err == nil {
		var v Verdict
		if json.Unmarshal(raw, &v) == nil {
			return Result{Verdict: v, Cached: true}, nil
		}
	}
	v, err := c.inner.Judge(ctx, r)
	if err != nil {
		return Result{}, err
	}
	raw, err := json.Marshal(v)
	if err != nil {
		return Result{}, err
	}
	if err := writeFile(p, raw); err != nil {
		// The verdict was paid for; a failed store only costs the next run a second call.
		slog.Warn("judgecache: store verdict", "err", err)
	}
	return Result{Verdict: v}, nil
}

// Marker is the scorecard label for a row: "cached" for a cache hit, else empty.
func Marker(r Result) string {
	if r.Cached {
		return "cached"
	}
	return ""
}

// Row renders a scorecard line for a judged item, with the cached marker when it applies.
func Row(name string, r Result) string {
	s := fmt.Sprintf("| %s | %t | %.2f |", name, r.Pass, r.Score)
	if m := Marker(r); m != "" {
		s += " " + m + " |"
	} else {
		s += " |"
	}
	return s
}
