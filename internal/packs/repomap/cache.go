package repomap

import (
	"encoding/json"
	"errors"
	"os"
	"time"
)

type cacheEntry struct {
	MtimeNano int64 `json:"mtime"`
	Size      int64 `json:"size"`
	Tags      []Tag `json:"tags"`
}

// Cache keeps the tags of each file keyed by its path, mtime and size, so an unchanged file is not parsed again.
type Cache struct {
	Entries map[string]cacheEntry `json:"entries"`
	Hits    int                   `json:"-"`
	Misses  int                   `json:"-"`
}

// NewCache returns an empty tag cache.
func NewCache() *Cache { return &Cache{Entries: map[string]cacheEntry{}} }

// LoadCache reads a cache saved by Save; a missing file gives an empty cache.
func LoadCache(path string) (*Cache, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return NewCache(), nil
	}
	if err != nil {
		return nil, err
	}
	c := NewCache()
	if err := json.Unmarshal(b, c); err != nil {
		return nil, err
	}
	if c.Entries == nil {
		c.Entries = map[string]cacheEntry{}
	}
	return c, nil
}

// Save writes the cache to path as JSON.
func (c *Cache) Save(path string) error {
	b, err := json.Marshal(c)
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}

func (c *Cache) get(rel string, mtime time.Time, size int64) ([]Tag, bool) {
	e, ok := c.Entries[rel]
	if ok && e.MtimeNano == mtime.UnixNano() && e.Size == size {
		c.Hits++
		return e.Tags, true
	}
	c.Misses++
	return nil, false
}

func (c *Cache) put(rel string, mtime time.Time, size int64, tags []Tag) {
	c.Entries[rel] = cacheEntry{MtimeNano: mtime.UnixNano(), Size: size, Tags: tags}
}
