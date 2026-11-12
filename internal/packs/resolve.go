package packs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

// ErrHashMismatch means a file at a pinned sha no longer has the content the lock recorded.
var ErrHashMismatch = errors.New("content hash mismatch")

// Resolver fetches refs and records them in a lock.
type Resolver struct {
	Fetcher Fetcher
	Lock    *Lock
}

// Resolve fetches ref, checks its licence, and records sha and sha256 in the lock. A ref with no sha
// uses the sha the lock holds for it, and fetches the default branch only when the lock has none.
// A pinned sha whose content differs from the lock fails with ErrHashMismatch.
func (r *Resolver) Resolve(ctx context.Context, kind Kind, refStr string) (Entry, error) {
	ref, err := ParseRef(refStr)
	if err != nil {
		return Entry{}, err
	}
	if !kind.Valid() {
		return Entry{}, fmt.Errorf("unknown kind %q", kind)
	}
	locked, have := r.Lock.Find(kind, ref)
	rev := ref.SHA
	pinned := have && (ref.SHA == "" || ref.SHA == locked.SHA || len(ref.SHA) < len(locked.SHA) && locked.SHA[:len(ref.SHA)] == ref.SHA)
	if pinned {
		rev = locked.SHA
	}
	f, err := r.Fetcher.Fetch(ctx, ref.Slug(), rev, ref.Path)
	if err != nil {
		return Entry{}, fmt.Errorf("fetch %s: %w", ref, err)
	}
	if err := CheckLicence(f.Licence); err != nil {
		return Entry{}, fmt.Errorf("%s: %w", ref, err)
	}
	sum := sha256.Sum256(f.Content)
	digest := hex.EncodeToString(sum[:])
	if pinned && digest != locked.SHA256 {
		return Entry{}, fmt.Errorf("%s at %s: %w: lock has %s, upstream has %s", ref.Path, locked.SHA, ErrHashMismatch, locked.SHA256, digest)
	}
	e := Entry{Kind: kind, Ref: Ref{Owner: ref.Owner, Repo: ref.Repo, SHA: f.SHA, Path: ref.Path}.String(), SHA: f.SHA, SHA256: digest, Licence: f.Licence}
	if pinned {
		e.EvalScore = locked.EvalScore
	}
	if err := r.Lock.Put(e); err != nil {
		return Entry{}, err
	}
	return e, nil
}
