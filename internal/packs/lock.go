package packs

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
)

// Kind says what a locked entry is.
type Kind string

// The kinds a lock entry may have.
const (
	KindSkill    Kind = "skill"
	KindAgent    Kind = "agent"
	KindWorkflow Kind = "workflow"
	KindCheck    Kind = "check"
)

// Valid reports whether k is one of the four kinds.
func (k Kind) Valid() bool {
	switch k {
	case KindSkill, KindAgent, KindWorkflow, KindCheck:
		return true
	}
	return false
}

// LockFile is the name of the lock file, a JSON document.
const LockFile = "factory.lock"

// Entry pins one fetched file. Ref carries the full sha it was fetched at.
type Entry struct {
	Kind      Kind     `json:"kind"`
	Ref       string   `json:"ref"`
	SHA       string   `json:"sha"`
	SHA256    string   `json:"sha256"`
	Licence   string   `json:"licence"`
	EvalScore *float64 `json:"eval_score,omitempty"`
}

// Lock is the parsed factory.lock.
type Lock struct {
	Version int     `json:"version"`
	Entries []Entry `json:"entries"`
}

// NewLock returns an empty lock at the current version.
func NewLock() *Lock { return &Lock{Version: 1} }

// Find returns the entry of the given kind for owner/repo#path, whatever its sha.
func (l *Lock) Find(kind Kind, r Ref) (Entry, bool) {
	for _, e := range l.Entries {
		er, err := ParseRef(e.Ref)
		if err == nil && e.Kind == kind && er.Slug() == r.Slug() && er.Path == r.Path {
			return e, true
		}
	}
	return Entry{}, false
}

// Put adds e, replacing an entry of the same kind, repo and path, and keeps the entries sorted.
func (l *Lock) Put(e Entry) error {
	nr, err := ParseRef(e.Ref)
	if err != nil {
		return err
	}
	if !e.Kind.Valid() {
		return fmt.Errorf("lock entry %s: unknown kind %q", e.Ref, e.Kind)
	}
	out := l.Entries[:0:0]
	for _, o := range l.Entries {
		or, err := ParseRef(o.Ref)
		if err == nil && o.Kind == e.Kind && or.Slug() == nr.Slug() && or.Path == nr.Path {
			continue
		}
		out = append(out, o)
	}
	out = append(out, e)
	sort.Slice(out, func(i, j int) bool {
		if out[i].Kind != out[j].Kind {
			return out[i].Kind < out[j].Kind
		}
		return out[i].Ref < out[j].Ref
	})
	l.Entries = out
	return nil
}

// Marshal returns the lock as indented JSON with a trailing newline.
func (l *Lock) Marshal() ([]byte, error) {
	b, err := json.MarshalIndent(l, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// ParseLock reads a lock and checks every entry.
func ParseLock(b []byte) (*Lock, error) {
	var l Lock
	if err := json.Unmarshal(b, &l); err != nil {
		return nil, fmt.Errorf("factory.lock: %w", err)
	}
	if l.Version != 1 {
		return nil, fmt.Errorf("factory.lock: unsupported version %d", l.Version)
	}
	for _, e := range l.Entries {
		r, err := ParseRef(e.Ref)
		if err != nil {
			return nil, err
		}
		if !e.Kind.Valid() || r.SHA == "" || e.SHA == "" || e.SHA256 == "" {
			return nil, fmt.Errorf("factory.lock: incomplete entry %s", e.Ref)
		}
	}
	return &l, nil
}

// ReadLock reads path, and returns an empty lock when the file does not exist.
func ReadLock(path string) (*Lock, error) {
	b, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return NewLock(), nil
	}
	if err != nil {
		return nil, err
	}
	return ParseLock(b)
}

// WriteLock writes the lock to path.
func WriteLock(path string, l *Lock) error {
	b, err := l.Marshal()
	if err != nil {
		return err
	}
	return os.WriteFile(path, b, 0o644)
}
