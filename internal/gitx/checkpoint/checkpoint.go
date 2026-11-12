// Ported from cline/cline@50e77bc1e8f7ab023b7986821e4b5f82ff51b8c4 sdk/packages/core/src/hooks/checkpoint-hooks.ts
// Ported from cline/cline@50e77bc1e8f7ab023b7986821e4b5f82ff51b8c4 sdk/packages/core/src/session/checkpoint-restore.ts
//
// Copyright Cline Bot Inc. Licensed under the Apache License, Version 2.0; see THIRD_PARTY_NOTICES.md.
// Changes: rewritten in Go over os/exec; metadata, telemetry and message trimming dropped; every
// checkpoint is stored under a private ref, so the ref is the only record of it.

// Package checkpoint snapshots a worktree before an agent session and restores it afterwards.
// A snapshot is a stash-shaped commit (tracked, staged and untracked files) kept under
// refs/factory/checkpoints/<session>/<run>. It never touches the user's index or refs/stash.
package checkpoint

import (
	"bytes"
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// MaxAge is how long a scratch dir or ref may sit idle before Reap removes it.
const MaxAge = 14 * 24 * time.Hour

const (
	refRoot   = "refs/factory/checkpoints/"
	msgPrefix = "factory checkpoint session="
	emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
)

// scratchConfig is pinned on every command that touches the scratch index. core.ignorestat=true
// would mark added entries assume-unchanged and freeze an edited file at its first snapshot's
// bytes; core.splitIndex would scatter shared-index files for our private index into .git.
var scratchConfig = []string{"-c", "core.ignorestat=false", "-c", "core.splitIndex=false"}

var sessionRe = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]*$`)

// Kind says how much of the worktree a checkpoint holds.
type Kind string

const (
	// KindHead is a clean tree: the checkpoint records HEAD only.
	KindHead Kind = "head"
	// KindStash is a dirty tree: tracked, staged and untracked files are recorded.
	KindStash Kind = "stash"
)

// Entry names one checkpoint.
type Entry struct {
	Run  int
	Ref  string // commit id; for KindStash its parents are base, index and (when untracked files exist) untracked
	Kind Kind
}

// Change is one path that differs between a checkpoint and the worktree now.
// Status is A (created since), M (modified) or D (deleted since).
type Change struct{ Status, Path string }

// Store holds the checkpoints of one session in one repository.
type Store struct {
	repo, session, scratch string
}

// New returns a Store for session in repo; scratchBase is the directory that holds per-session
// scratch dirs. The session id becomes a ref path component and must be a plain name.
func New(repo, scratchBase, session string) (*Store, error) {
	if !sessionRe.MatchString(session) || strings.Contains(session, "..") || strings.HasSuffix(session, ".lock") {
		return nil, fmt.Errorf("checkpoint: invalid session id %q", session)
	}
	sum := sha256.Sum256([]byte(repo + "\x00" + session))
	return &Store{repo: repo, session: session, scratch: filepath.Join(scratchBase, fmt.Sprintf("%x", sum)[:32])}, nil
}

func (s *Store) ref(run int) string { return refRoot + s.session + "/" + strconv.Itoa(run) }

// git runs git in the repo. env and stdin are optional. The identity is pinned because
// commit-tree needs one and the machine may have none.
func (s *Store) git(ctx context.Context, env []string, stdin string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", s.repo}, args...)...)
	cmd.Env = append(os.Environ(), "LC_ALL=C", "GIT_TERMINAL_PROMPT=0",
		"GIT_AUTHOR_NAME=factory", "GIT_AUTHOR_EMAIL=factory@localhost",
		"GIT_COMMITTER_NAME=factory", "GIT_COMMITTER_EMAIL=factory@localhost")
	cmd.Env = append(cmd.Env, env...)
	if stdin != "" {
		cmd.Stdin = strings.NewReader(stdin)
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return out.String(), fmt.Errorf("checkpoint: git %s: %w: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func (s *Store) line(ctx context.Context, args ...string) (string, error) {
	out, err := s.git(ctx, nil, "", args...)
	return strings.TrimSpace(out), err
}

func (s *Store) scratchGit(ctx context.Context, stdin string, args ...string) (string, error) {
	return s.git(ctx, []string{"GIT_INDEX_FILE=" + filepath.Join(s.scratch, "index")}, stdin, append(append([]string{}, scratchConfig...), args...)...)
}

// untrackedCommit builds a commit holding only the untracked, not ignored files, through the
// persistent scratch index so unchanged files are not re-hashed. It returns "" when there are none.
func (s *Store) untrackedCommit(ctx context.Context) (string, error) {
	list, err := s.git(ctx, nil, "", "ls-files", "--others", "--exclude-standard", "-z")
	if err != nil {
		return "", err
	}
	var files []string
	set := map[string]bool{}
	for _, f := range strings.Split(list, "\x00") {
		if f != "" {
			files = append(files, f)
			set[strings.TrimSuffix(f, "/")] = true
		}
	}
	if len(files) == 0 {
		return "", nil
	}
	if err := os.MkdirAll(s.scratch, 0o700); err != nil {
		return "", err
	}
	pathspec := strings.Join(files, "\x00") + "\x00"
	add := []string{"add", "--force", "--pathspec-from-file=-", "--pathspec-file-nul"}
	if _, err := s.scratchGit(ctx, pathspec, add...); err != nil {
		// A file vanishing between the listing and the add is a per-call race, not index damage.
		if strings.Contains(err.Error(), "did not match any files") {
			return "", err
		}
		// A corrupt index or stale lock would fail every later call; clear both and rebuild once.
		idx := filepath.Join(s.scratch, "index")
		_ = os.Remove(idx)
		_ = os.Remove(idx + ".lock")
		if _, err := s.scratchGit(ctx, pathspec, add...); err != nil {
			return "", err
		}
	}
	// git add with a pathspec never removes entries: drop those that left the untracked set.
	// A nested repo lists as "sub/" but is indexed as the gitlink "sub", hence the TrimSuffix above.
	indexed, err := s.scratchGit(ctx, "", "ls-files", "-z")
	if err != nil {
		return "", err
	}
	var stale []string
	for _, p := range strings.Split(indexed, "\x00") {
		if p != "" && !set[p] {
			stale = append(stale, p)
		}
	}
	if len(stale) > 0 {
		if _, err := s.scratchGit(ctx, strings.Join(stale, "\x00")+"\x00", "update-index", "-z", "--force-remove", "--stdin"); err != nil {
			return "", err
		}
	}
	tree, err := s.scratchGit(ctx, "", "write-tree")
	if err != nil {
		return "", err
	}
	c, err := s.scratchGit(ctx, "", "commit-tree", strings.TrimSpace(tree), "-m", "untracked files on factory checkpoint")
	return strings.TrimSpace(c), err
}

// snapshotCommit creates the checkpoint commit without storing it under any ref.
func (s *Store) snapshotCommit(ctx context.Context, msg string) (string, Kind, error) {
	stash, err := s.line(ctx, "stash", "create", msg)
	if err != nil {
		return "", "", err
	}
	untracked, err := s.untrackedCommit(ctx)
	if err != nil {
		return "", "", err
	}
	if stash != "" && untracked == "" {
		return stash, KindStash, nil
	}
	head, err := s.line(ctx, "rev-parse", "HEAD")
	if err != nil {
		return "", "", err
	}
	if stash == "" && untracked == "" {
		// Clean tree: a fresh one-parent commit, so the ref carries its own creation date for Reap.
		c, err := s.line(ctx, "commit-tree", head+"^{tree}", "-p", head, "-m", msg)
		return c, KindHead, err
	}
	tree, base, index := head+"^{tree}", head, ""
	if stash != "" {
		tree, base, index = stash+"^{tree}", stash+"^1", stash+"^2"
	} else if index, err = s.line(ctx, "commit-tree", tree, "-p", head, "-m", "index on factory checkpoint"); err != nil {
		return "", "", err
	}
	c, err := s.line(ctx, "commit-tree", tree, "-p", base, "-p", index, "-p", untracked, "-m", msg)
	return c, KindStash, err
}

// Snapshot records the worktree as checkpoint run and returns it. A clean tree records HEAD only.
func (s *Store) Snapshot(ctx context.Context, run int) (Entry, error) {
	c, kind, err := s.snapshotCommit(ctx, msgPrefix+s.session+" run="+strconv.Itoa(run))
	if err != nil {
		return Entry{}, err
	}
	if _, err := s.git(ctx, nil, "", "update-ref", s.ref(run), c); err != nil {
		return Entry{}, err
	}
	return Entry{Run: run, Ref: c, Kind: kind}, nil
}

func (s *Store) entry(ctx context.Context, run int) (Entry, error) {
	c, err := s.line(ctx, "rev-parse", "--verify", "--quiet", s.ref(run)+"^{commit}")
	if err != nil || c == "" {
		return Entry{}, fmt.Errorf("checkpoint: no checkpoint for run %d in session %s", run, s.session)
	}
	parents, err := s.line(ctx, "show", "-s", "--format=%P", c)
	if err != nil {
		return Entry{}, err
	}
	kind := KindHead
	if len(strings.Fields(parents)) >= 2 {
		kind = KindStash
	}
	return Entry{Run: run, Ref: c, Kind: kind}, nil
}

// Restore returns the worktree to checkpoint run: tracked, staged and untracked files as they were,
// and files created since removed. Ignored files are left alone. It refuses when HEAD is no longer
// the commit the checkpoint was taken on, so no commit is ever dropped from the branch.
func (s *Store) Restore(ctx context.Context, run int) error {
	e, err := s.entry(ctx, run)
	if err != nil {
		return err
	}
	base, err := s.line(ctx, "rev-parse", "--verify", e.Ref+"^1^{commit}")
	if err != nil {
		return err
	}
	head, err := s.line(ctx, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return err
	}
	if head != base {
		return fmt.Errorf("checkpoint: cannot restore run %d: HEAD is %s but the checkpoint was taken on %s", run, head[:12], base[:12])
	}
	if _, err := s.git(ctx, nil, "", "reset", "--hard"); err != nil {
		return err
	}
	// Snapshot records every untracked file, so whatever is untracked now was created since.
	// Clearing before apply also avoids "already exists" conflicts; ignored files stay.
	if _, err := s.git(ctx, nil, "", "clean", "-fd"); err != nil {
		return err
	}
	if e.Kind == KindHead {
		return nil
	}
	_, err = s.git(ctx, nil, "", "stash", "apply", "--index", e.Ref)
	return err
}

// Diff lists the paths that differ between checkpoint run and the worktree now, sorted by path.
func (s *Store) Diff(ctx context.Context, run int) ([]Change, error) {
	then, err := s.entry(ctx, run)
	if err != nil {
		return nil, err
	}
	now, _, err := s.snapshotCommit(ctx, "factory checkpoint diff")
	if err != nil {
		return nil, err
	}
	var out []Change
	for _, sel := range []string{"^{tree}", "^3^{tree}"} {
		a, b := s.treeOf(ctx, then.Ref, sel), s.treeOf(ctx, now, sel)
		o, err := s.git(ctx, nil, "", "diff-tree", "-r", "-z", "--name-status", a, b)
		if err != nil {
			return nil, err
		}
		f := strings.Split(strings.TrimSuffix(o, "\x00"), "\x00")
		for i := 0; i+1 < len(f); i += 2 {
			out = append(out, Change{f[i], f[i+1]})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// treeOf resolves a tree of commit c; a missing third parent is the empty tree.
func (s *Store) treeOf(ctx context.Context, c, sel string) string {
	t, err := s.line(ctx, "rev-parse", "--verify", "--quiet", c+sel)
	if err != nil || t == "" {
		return emptyTree
	}
	return t
}

// Delete removes this session's refs and scratch dir. Missing ones are not an error.
func (s *Store) Delete(ctx context.Context) error {
	errs := []error{os.RemoveAll(s.scratch)}
	out, err := s.line(ctx, "for-each-ref", "--format=%(refname)", refRoot+s.session+"/")
	errs = append(errs, err)
	for _, r := range strings.Fields(out) {
		_, err := s.git(ctx, nil, "", "update-ref", "-d", r)
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// Reap removes scratch dirs under scratchBase whose mtime is older than MaxAge before now, and
// checkpoint refs in repo whose commit is older than that. It catches sessions that never ended.
func Reap(ctx context.Context, repo, scratchBase string, now time.Time) error {
	cutoff := now.Add(-MaxAge)
	var errs []error
	ents, err := os.ReadDir(scratchBase)
	if err != nil && !os.IsNotExist(err) {
		errs = append(errs, err)
	}
	for _, e := range ents {
		if info, err := e.Info(); e.IsDir() && err == nil && info.ModTime().Before(cutoff) {
			errs = append(errs, os.RemoveAll(filepath.Join(scratchBase, e.Name())))
		}
	}
	g := &Store{repo: repo}
	out, err := g.line(ctx, "for-each-ref", "--format=%(refname) %(committerdate:unix)", refRoot)
	errs = append(errs, err)
	for _, l := range strings.Split(out, "\n") {
		name, ts, ok := strings.Cut(l, " ")
		if sec, perr := strconv.ParseInt(ts, 10, 64); ok && perr == nil && time.Unix(sec, 0).Before(cutoff) {
			_, err := g.git(ctx, nil, "", "update-ref", "-d", name)
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}
