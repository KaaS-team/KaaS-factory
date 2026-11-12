package packs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const mitText = "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy\n"

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com",
		"GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v: %s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// upstream builds a work tree with a licence and one skill, and a bare remote it is pushed to.
type upstreamRepo struct{ work, bare string }

func newUpstream(t *testing.T, licence, skill string) *upstreamRepo {
	t.Helper()
	root := t.TempDir()
	u := &upstreamRepo{work: filepath.Join(root, "work"), bare: filepath.Join(root, "up.git")}
	git(t, root, "init", "--quiet", "--bare", "-b", "main", u.bare)
	git(t, root, "init", "--quiet", "-b", "main", u.work)
	u.commit(t, licence, skill)
	return u
}

func (u *upstreamRepo) commit(t *testing.T, licence, skill string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(u.work, "skills/x"), 0o755); err != nil {
		t.Fatal(err)
	}
	for p, c := range map[string]string{"LICENSE": licence, "skills/x/SKILL.md": skill} {
		if err := os.WriteFile(filepath.Join(u.work, p), []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	git(t, u.work, "add", "-A")
	git(t, u.work, "commit", "--quiet", "-m", "c")
	git(t, u.work, "push", "--quiet", "--force", u.bare, "main")
	return git(t, u.work, "rev-parse", "HEAD")
}

func (u *upstreamRepo) fetcher(t *testing.T) GitFetcher {
	return GitFetcher{Remote: func(string) string { return u.bare }, Cache: t.TempDir()}
}

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestResolveRecordsShaAndHash(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	head := git(t, u.work, "rev-parse", "HEAD")
	r := &Resolver{Fetcher: u.fetcher(t), Lock: NewLock()}
	e, err := r.Resolve(context.Background(), KindSkill, "o/r#skills/x/SKILL.md")
	if err != nil {
		t.Fatal(err)
	}
	if e.SHA != head || e.SHA256 != sum("v1") || e.Licence != "MIT" || e.Ref != "o/r@"+head+"#skills/x/SKILL.md" {
		t.Fatalf("entry %+v", e)
	}
	if got, ok := r.Lock.Find(KindSkill, Ref{Owner: "o", Repo: "r", Path: "skills/x/SKILL.md"}); !ok || got != e {
		t.Fatalf("lock has %+v %v", got, ok)
	}
	// The lock survives a write and read.
	path := filepath.Join(t.TempDir(), LockFile)
	if err := WriteLock(path, r.Lock); err != nil {
		t.Fatal(err)
	}
	back, err := ReadLock(path)
	if err != nil || len(back.Entries) != 1 || back.Entries[0] != e {
		t.Fatalf("read back %+v %v", back, err)
	}
}

func TestResolvePinnedShaWithChangedUpstreamFailsHashCheck(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	head := git(t, u.work, "rev-parse", "HEAD")
	lock := NewLock()
	r := &Resolver{Fetcher: u.fetcher(t), Lock: lock}
	if _, err := r.Resolve(context.Background(), KindSkill, "o/r@"+head+"#skills/x/SKILL.md"); err != nil {
		t.Fatal(err)
	}
	// Same sha, the upstream file now has different content: the fetcher is a stand-in that serves it.
	tampered := fakeFetcher{f: Fetched{SHA: head, Content: []byte("v2"), Licence: "MIT"}}
	r2 := &Resolver{Fetcher: tampered, Lock: lock}
	_, err := r2.Resolve(context.Background(), KindSkill, "o/r@"+head+"#skills/x/SKILL.md")
	if !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("want ErrHashMismatch, got %v", err)
	}
	// An unpinned ref uses the locked sha, so it fails the same way.
	if _, err := r2.Resolve(context.Background(), KindSkill, "o/r#skills/x/SKILL.md"); !errors.Is(err, ErrHashMismatch) {
		t.Fatalf("unpinned: want ErrHashMismatch, got %v", err)
	}
}

func TestResolveNewShaUpdatesTheLock(t *testing.T) {
	u := newUpstream(t, mitText, "v1")
	lock := NewLock()
	r := &Resolver{Fetcher: u.fetcher(t), Lock: lock}
	if _, err := r.Resolve(context.Background(), KindSkill, "o/r#skills/x/SKILL.md"); err != nil {
		t.Fatal(err)
	}
	second := u.commit(t, mitText, "v2")
	e, err := r.Resolve(context.Background(), KindSkill, "o/r@"+second+"#skills/x/SKILL.md")
	if err != nil || e.SHA != second || e.SHA256 != sum("v2") || len(lock.Entries) != 1 {
		t.Fatalf("%+v %v entries=%d", e, err, len(lock.Entries))
	}
}

func TestResolveRefusesLicence(t *testing.T) {
	texts := map[string]string{
		"AGPL-3.0":     "GNU AFFERO GENERAL PUBLIC LICENSE\nVersion 3",
		"GPL-3.0":      "GNU GENERAL PUBLIC LICENSE\nVersion 3",
		"CC-BY-SA-4.0": "Attribution-ShareAlike 4.0 International",
		"NOASSERTION":  "do what you like",
	}
	for id, text := range texts {
		u := newUpstream(t, text, "v1")
		r := &Resolver{Fetcher: u.fetcher(t), Lock: NewLock()}
		_, err := r.Resolve(context.Background(), KindSkill, "o/r#skills/x/SKILL.md")
		if err == nil || !strings.Contains(err.Error(), id) {
			t.Errorf("%s: err %v", id, err)
		}
		if len(r.Lock.Entries) != 0 {
			t.Errorf("%s: refused ref was locked", id)
		}
	}
	// An empty licence from the fetcher is refused, MIT and Apache-2.0 pass.
	for lic, refused := range map[string]bool{"": true, "MIT": false, "Apache-2.0": false} {
		r := &Resolver{Fetcher: fakeFetcher{f: Fetched{SHA: strings.Repeat("a", 40), Content: []byte("x"), Licence: lic}}, Lock: NewLock()}
		_, err := r.Resolve(context.Background(), KindCheck, "o/r#c.sh")
		if refused != (err != nil) {
			t.Errorf("licence %q: err %v", lic, err)
		}
	}
}

func TestResolveRejectsBadInput(t *testing.T) {
	r := &Resolver{Fetcher: fakeFetcher{}, Lock: NewLock()}
	if _, err := r.Resolve(context.Background(), KindSkill, "nope"); err == nil {
		t.Error("bad ref accepted")
	}
	if _, err := r.Resolve(context.Background(), Kind("plugin"), "o/r#p"); err == nil {
		t.Error("bad kind accepted")
	}
}

func TestLockParseRejects(t *testing.T) {
	for _, in := range []string{`{`, `{"version":2,"entries":[]}`,
		`{"version":1,"entries":[{"kind":"skill","ref":"o/r#p","sha":"a","sha256":"b"}]}`,
		`{"version":1,"entries":[{"kind":"bogus","ref":"o/r@abcdef1#p","sha":"a","sha256":"b"}]}`} {
		if _, err := ParseLock([]byte(in)); err == nil {
			t.Errorf("%s accepted", in)
		}
	}
}

type fakeFetcher struct{ f Fetched }

func (f fakeFetcher) Fetch(context.Context, string, string, string) (Fetched, error) { return f.f, nil }
