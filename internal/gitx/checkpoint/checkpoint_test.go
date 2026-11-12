package checkpoint_test

import (
	"context"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/gitx/checkpoint"
)

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"}, args...)...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func put(t *testing.T, dir, name, content string) {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func rm(t *testing.T, dir, name string) {
	t.Helper()
	if err := os.Remove(filepath.Join(dir, name)); err != nil {
		t.Fatal(err)
	}
}

// newRepo returns a repo with one commit holding a.txt, b.txt and a .gitignore for *.log.
func newRepo(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	git(t, dir, "init", "-q", "-b", "main")
	put(t, dir, "a.txt", "alpha\n")
	put(t, dir, "b.txt", "bravo\n")
	put(t, dir, ".gitignore", "*.log\n")
	git(t, dir, "add", ".")
	git(t, dir, "commit", "-q", "-m", "init")
	return dir
}

// digest hashes every file outside .git (path and bytes) so two worktrees compare byte for byte.
func digest(t *testing.T, dir string) string {
	t.Helper()
	h := sha256.New()
	var names []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && d.Name() == ".git" {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			names = append(names, p)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(names)
	for _, p := range names {
		b, err := os.ReadFile(p)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = fmt.Fprintf(h, "%s\x00%d\x00%s\x00", p, len(b), b)
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

// userState is everything a checkpoint must not touch: the index, the stash list and the branch.
func userState(t *testing.T, dir string) string {
	t.Helper()
	return strings.Join([]string{
		git(t, dir, "ls-files", "-s"),
		git(t, dir, "stash", "list"),
		git(t, dir, "rev-parse", "HEAD"),
		git(t, dir, "status", "--porcelain=v1"),
	}, "\n--\n")
}

func newStore(t *testing.T, repo, session string) *checkpoint.Store {
	t.Helper()
	s, err := checkpoint.New(repo, t.TempDir(), session)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

// agentEdits mutates the tree the way an agent session would.
func agentEdits(t *testing.T, dir string) {
	t.Helper()
	put(t, dir, "a.txt", "ALPHA changed by agent\n")
	rm(t, dir, "b.txt")
	put(t, dir, "new.txt", "created by agent\n")
	put(t, dir, "scratch.go", "package main // rewritten\n")
	git(t, dir, "add", "new.txt")
}

func TestCleanTreeRoundTrip(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	want := digest(t, repo)
	s := newStore(t, repo, "s1")
	e, err := s.Snapshot(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != checkpoint.KindHead {
		t.Fatalf("clean tree: kind = %q, want head", e.Kind)
	}
	agentEdits(t, repo)
	if err := s.Restore(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := digest(t, repo); got != want {
		t.Fatal("clean tree not restored byte for byte")
	}
	if st := git(t, repo, "status", "--porcelain=v1"); st != "" {
		t.Fatalf("status after restore: %q", st)
	}
}

func TestDirtyTreeRoundTrip(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	put(t, repo, "a.txt", "alpha dirty\n")            // tracked, unstaged
	put(t, repo, "b.txt", "bravo staged\n")           // tracked, staged
	git(t, repo, "add", "b.txt")                      //
	put(t, repo, "u/deep/one.txt", "untracked one\n") // untracked
	put(t, repo, "debug.log", "ignored, left alone\n")
	want := digest(t, repo)
	before := userState(t, repo)
	s := newStore(t, repo, "s2")
	e, err := s.Snapshot(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != checkpoint.KindStash {
		t.Fatalf("kind = %q, want stash", e.Kind)
	}
	if after := userState(t, repo); after != before {
		t.Fatalf("snapshot touched the user's index, stash or branch:\n%s\n!=\n%s", before, after)
	}
	agentEdits(t, repo)
	put(t, repo, "u/deep/one.txt", "agent rewrote this\n")
	put(t, repo, "u/two.txt", "agent made this\n")
	if err := s.Restore(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := digest(t, repo); got != want {
		t.Fatal("dirty tree not restored byte for byte")
	}
	if got := git(t, repo, "diff", "--cached", "--name-only"); got != "b.txt" {
		t.Fatalf("staged set after restore = %q, want b.txt", got)
	}
	if got := git(t, repo, "stash", "list"); got != "" {
		t.Fatalf("restore left a stash entry: %q", got)
	}
}

func TestUntrackedOnly(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	put(t, repo, "only.txt", "just untracked\n")
	want := digest(t, repo)
	s := newStore(t, repo, "s3")
	e, err := s.Snapshot(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if e.Kind != checkpoint.KindStash {
		t.Fatalf("kind = %q, want stash", e.Kind)
	}
	put(t, repo, "only.txt", "changed\n")
	put(t, repo, "extra.txt", "extra\n")
	rm(t, repo, "a.txt")
	if err := s.Restore(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if got := digest(t, repo); got != want {
		t.Fatal("untracked-only tree not restored byte for byte")
	}
}

// With core.ignorestat=true a persistent scratch index would mark entries assume-unchanged and
// keep the first snapshot's bytes for an edited untracked file.
func TestIgnoreStat(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	git(t, repo, "config", "core.ignorestat", "true")
	put(t, repo, "note.txt", "first\n")
	s := newStore(t, repo, "s4")
	if _, err := s.Snapshot(ctx, 1); err != nil {
		t.Fatal(err)
	}
	put(t, repo, "note.txt", "second, and longer\n")
	put(t, repo, "a.txt", "alpha edited\n")
	want := digest(t, repo)
	if _, err := s.Snapshot(ctx, 2); err != nil {
		t.Fatal(err)
	}
	put(t, repo, "note.txt", "agent\n")
	put(t, repo, "a.txt", "agent\n")
	if err := s.Restore(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if got := digest(t, repo); got != want {
		t.Fatal("second snapshot kept stale bytes under core.ignorestat=true")
	}
}

// A file that leaves the untracked set must not ghost into later snapshots.
func TestStaleUntrackedDropped(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	put(t, repo, "gone.txt", "temp\n")
	put(t, repo, "stay.txt", "stay\n")
	s := newStore(t, repo, "s5")
	if _, err := s.Snapshot(ctx, 1); err != nil {
		t.Fatal(err)
	}
	rm(t, repo, "gone.txt")
	want := digest(t, repo)
	if _, err := s.Snapshot(ctx, 2); err != nil {
		t.Fatal(err)
	}
	put(t, repo, "gone.txt", "agent recreated\n")
	if err := s.Restore(ctx, 2); err != nil {
		t.Fatal(err)
	}
	if got := digest(t, repo); got != want {
		t.Fatal("deleted untracked file came back from a stale index entry")
	}
}

func TestNestedRepoKeptInSnapshot(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	put(t, repo, "sub/f.txt", "x\n")
	git(t, filepath.Join(repo, "sub"), "init", "-q", "-b", "main")
	git(t, filepath.Join(repo, "sub"), "add", ".")
	git(t, filepath.Join(repo, "sub"), "commit", "-q", "-m", "c")
	s := newStore(t, repo, "s6")
	e, err := s.Snapshot(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if out := git(t, repo, "ls-tree", e.Ref+"^3", "sub"); !strings.HasPrefix(out, "160000 commit") {
		t.Fatalf("nested repo gitlink missing from untracked parent: %q", out)
	}
}

func TestRestoreRefusesMovedHead(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	s := newStore(t, repo, "s7")
	if _, err := s.Snapshot(ctx, 1); err != nil {
		t.Fatal(err)
	}
	put(t, repo, "a.txt", "committed later\n")
	git(t, repo, "commit", "-q", "-am", "later")
	head := git(t, repo, "rev-parse", "HEAD")
	if err := s.Restore(ctx, 1); err == nil {
		t.Fatal("restore moved the branch off a later commit")
	}
	if got := git(t, repo, "rev-parse", "HEAD"); got != head {
		t.Fatalf("HEAD moved to %s", got)
	}
}

func TestRestoreUnknownRun(t *testing.T) {
	repo := newRepo(t)
	s := newStore(t, repo, "s8")
	if err := s.Restore(context.Background(), 9); err == nil {
		t.Fatal("restore of a run with no checkpoint succeeded")
	}
}

func TestSessionIDValidation(t *testing.T) {
	repo := newRepo(t)
	for _, id := range []string{"", "a/b", "..", "a..b", ".x", "x.lock", "a b", "a:b"} {
		if _, err := checkpoint.New(repo, t.TempDir(), id); err == nil {
			t.Errorf("session id %q accepted", id)
		}
	}
	if _, err := checkpoint.New(repo, t.TempDir(), "run-42_a.b"); err != nil {
		t.Errorf("valid id rejected: %v", err)
	}
}

func TestDiff(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	put(t, repo, "keep.txt", "k\n")
	put(t, repo, "mod.txt", "m1\n")
	s := newStore(t, repo, "s9")
	if _, err := s.Snapshot(ctx, 1); err != nil {
		t.Fatal(err)
	}
	if ch, err := s.Diff(ctx, 1); err != nil || len(ch) != 0 {
		t.Fatalf("diff on an untouched tree = %v, %v", ch, err)
	}
	put(t, repo, "a.txt", "tracked edit\n")
	put(t, repo, "mod.txt", "m2 longer\n")
	rm(t, repo, "keep.txt")
	put(t, repo, "fresh.txt", "new\n")
	got, err := s.Diff(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	want := []checkpoint.Change{{"M", "a.txt"}, {"A", "fresh.txt"}, {"D", "keep.txt"}, {"M", "mod.txt"}}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("diff = %v, want %v", got, want)
	}
	if userState(t, repo) == "" {
		t.Fatal("unreachable")
	}
}

func refs(t *testing.T, repo string) string {
	return git(t, repo, "for-each-ref", "refs/factory/")
}

func TestDeleteRemovesRefsAndScratch(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	base := t.TempDir()
	put(t, repo, "u.txt", "u\n")
	s, err := checkpoint.New(repo, base, "s10")
	if err != nil {
		t.Fatal(err)
	}
	other, _ := checkpoint.New(repo, base, "other")
	for _, st := range []*checkpoint.Store{s, other} {
		if _, err := st.Snapshot(ctx, 1); err != nil {
			t.Fatal(err)
		}
	}
	if ents, _ := os.ReadDir(base); len(ents) != 2 {
		t.Fatalf("want 2 scratch dirs, got %d", len(ents))
	}
	if err := s.Delete(ctx); err != nil {
		t.Fatal(err)
	}
	if ents, _ := os.ReadDir(base); len(ents) != 1 {
		t.Fatalf("scratch dir not removed: %d left", len(ents))
	}
	r := refs(t, repo)
	if strings.Contains(r, "/s10/") || !strings.Contains(r, "/other/1") {
		t.Fatalf("delete removed the wrong refs:\n%s", r)
	}
	if err := s.Delete(ctx); err != nil {
		t.Fatalf("second delete: %v", err)
	}
}

func TestReapAfterFourteenDays(t *testing.T) {
	ctx := context.Background()
	repo := newRepo(t)
	base := t.TempDir()
	put(t, repo, "u.txt", "u\n")
	s, _ := checkpoint.New(repo, base, "old")
	if _, err := s.Snapshot(ctx, 1); err != nil {
		t.Fatal(err)
	}
	now := time.Now()
	for _, tc := range []struct {
		name string
		at   time.Duration
		kept bool
	}{
		{"13 days", 13 * 24 * time.Hour, true},
		{"15 days", 15 * 24 * time.Hour, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := checkpoint.Reap(ctx, repo, base, now.Add(tc.at)); err != nil {
				t.Fatal(err)
			}
			ents, _ := os.ReadDir(base)
			if kept := len(ents) == 1; kept != tc.kept {
				t.Fatalf("scratch dir kept = %v, want %v", kept, tc.kept)
			}
			if kept := refs(t, repo) != ""; kept != tc.kept {
				t.Fatalf("ref kept = %v, want %v", kept, tc.kept)
			}
		})
	}
}
