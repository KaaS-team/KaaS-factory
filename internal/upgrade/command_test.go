package upgrade

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/packs"
)

type fakeScorer struct{ old, next eval.Scorecard }

func (f fakeScorer) Score(context.Context, Candidate) (eval.Scorecard, eval.Scorecard, error) {
	return f.old, f.next, nil
}

func runnerFixture(t *testing.T, next eval.Scorecard) (Runner, string) {
	t.Helper()
	dir := t.TempDir()
	lock := lockOf(t, entry("o/r", "skills/a/SKILL.md", shaA, "old"))
	if err := packs.WriteLock(filepath.Join(dir, packs.LockFile), lock); err != nil {
		t.Fatal(err)
	}
	up := fakeUpstream{
		head:  map[string]string{"o/r": shaB},
		files: map[string]packs.Fetched{"o/r@" + shaB + "#skills/a/SKILL.md": {SHA: shaB, Content: []byte("new"), Licence: "MIT"}},
	}
	return Runner{Upstream: up, Scorer: fakeScorer{sc(0.8, 1000), next}}, dir
}

func TestRunDryRunWritesNothing(t *testing.T) {
	r, dir := runnerFixture(t, sc(0.9, 1000))
	before, _ := os.ReadFile(filepath.Join(dir, packs.LockFile))
	var lines []string
	if err := r.Run(context.Background(), dir, 0, true, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(filepath.Join(dir, packs.LockFile))
	if !bytes.Equal(before, after) || len(lines) != 1 || !strings.HasPrefix(lines[0], "bump ") {
		t.Fatalf("lines %v", lines)
	}
	if _, err := os.Stat(filepath.Join(dir, PRBodyFile)); err == nil {
		t.Fatal("dry run wrote a PR body")
	}
}

func TestRunAppliesOrRefuses(t *testing.T) {
	r, dir := runnerFixture(t, sc(0.9, 1000))
	if err := r.Run(context.Background(), dir, 0, false, func(string) {}); err != nil {
		t.Fatal(err)
	}
	l, _ := packs.ReadLock(filepath.Join(dir, packs.LockFile))
	if e, _ := l.Find(packs.KindSkill, packs.Ref{Owner: "o", Repo: "r", Path: "skills/a/SKILL.md"}); e.SHA != shaB {
		t.Fatalf("not bumped: %+v", e)
	}
	r, dir = runnerFixture(t, sc(0.5, 1000))
	var lines []string
	if err := r.Run(context.Background(), dir, 0, false, func(s string) { lines = append(lines, s) }); err != nil {
		t.Fatal(err)
	}
	l, _ = packs.ReadLock(filepath.Join(dir, packs.LockFile))
	if e, _ := l.Find(packs.KindSkill, packs.Ref{Owner: "o", Repo: "r", Path: "skills/a/SKILL.md"}); e.SHA != shaA || !strings.HasPrefix(lines[0], "refused ") {
		t.Fatalf("bumped on refusal: %+v %v", e, lines)
	}
}

func TestNewCommandFlags(t *testing.T) {
	c := NewCommand()
	if c.Use != "upgrade" || c.Flags().Lookup("dry-run") == nil || c.Flags().Lookup("tolerance") == nil {
		t.Fatal("flags missing")
	}
}
