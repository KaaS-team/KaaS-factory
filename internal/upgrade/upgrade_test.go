package upgrade

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/packs"
)

type fakeUpstream struct {
	head  map[string]string
	files map[string]packs.Fetched // key slug@sha#path
}

func (f fakeUpstream) Head(_ context.Context, slug string) (string, error) { return f.head[slug], nil }
func (f fakeUpstream) Fetch(_ context.Context, slug, rev, path string) (packs.Fetched, error) {
	return f.files[slug+"@"+rev+"#"+path], nil
}

func sum(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}

const (
	shaA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	shaB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

func entry(slug, path, sha, content string) packs.Entry {
	return packs.Entry{Kind: packs.KindSkill, Ref: slug + "@" + sha + "#" + path, SHA: sha, SHA256: sum(content), Licence: "MIT"}
}

func lockOf(t *testing.T, es ...packs.Entry) *packs.Lock {
	t.Helper()
	l := packs.NewLock()
	for _, e := range es {
		if err := l.Put(e); err != nil {
			t.Fatal(err)
		}
	}
	return l
}

// Symphony §8.2 style reconcile: only a changed sha with a changed path hash is a candidate.
func TestPlan(t *testing.T) {
	cases := []struct {
		name   string
		head   string
		newTxt string
		want   int
	}{
		{"unchanged sha", shaA, "old", 0},
		{"changed sha same path hash", shaB, "old", 0},
		{"changed sha changed hash", shaB, "new", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			lock := lockOf(t, entry("o/r", "skills/a/SKILL.md", shaA, "old"))
			up := fakeUpstream{
				head:  map[string]string{"o/r": c.head},
				files: map[string]packs.Fetched{"o/r@" + shaB + "#skills/a/SKILL.md": {SHA: shaB, Content: []byte(c.newTxt), Licence: "MIT"}},
			}
			got, err := Plan(context.Background(), lock, up)
			if err != nil {
				t.Fatal(err)
			}
			if len(got) != c.want {
				t.Fatalf("got %d candidates, want %d", len(got), c.want)
			}
			if c.want == 1 && (got[0].New.SHA != shaB || got[0].New.SHA256 != sum("new")) {
				t.Fatalf("bad candidate %+v", got[0])
			}
		})
	}
}

func sc(pass float64, tokens int64) eval.Scorecard {
	return eval.Scorecard{Model: "model-x-9", Aggregate: eval.Aggregate{PassRate: pass, TokensPerMergedPR: tokens, Merged: 4, Total: 5}}
}

func TestDecide(t *testing.T) {
	cases := []struct {
		name     string
		old, new eval.Scorecard
		tol      float64
		bump     bool
		reason   string
	}{
		{"lower pass rate", sc(0.8, 1000), sc(0.6, 900), 0.05, false, "pass rate fell from 0.80 to 0.60"},
		{"equal pass, tokens equal", sc(0.8, 1000), sc(0.8, 1000), 0.05, true, "pass rate not lower and tokens per merged PR within 5%"},
		{"higher pass, tokens within tolerance", sc(0.8, 1000), sc(0.9, 1050), 0.05, true, "pass rate not lower and tokens per merged PR within 5%"},
		{"tokens over tolerance", sc(0.8, 1000), sc(0.8, 1051), 0.05, false, "tokens per merged PR rose from 1000 to 1051, more than 5%"},
		{"zero tolerance uses default", sc(0.8, 1000), sc(0.8, 1049), 0, true, "pass rate not lower and tokens per merged PR within 5%"},
		{"no old tokens", sc(0.8, 0), sc(0.8, 500), 0.05, true, "pass rate not lower and tokens per merged PR within 5%"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			v := Decide(c.old, c.new, c.tol)
			if v.Bump != c.bump || v.Reason != c.reason {
				t.Fatalf("got %+v", v)
			}
		})
	}
}

func TestJudgeRefusesLicenceChange(t *testing.T) {
	c := Candidate{Old: entry("o/r", "p.md", shaA, "x"), New: entry("o/r", "p.md", shaB, "y")}
	c.New.Licence = "AGPL-3.0"
	v := Judge(c, sc(0.8, 1000), sc(0.9, 900), 0.05)
	if v.Bump || !strings.Contains(v.Reason, "licence") || !strings.Contains(v.Reason, "AGPL-3.0") {
		t.Fatalf("got %+v", v)
	}
	c.New.Licence = "MIT"
	if v := Judge(c, sc(0.8, 1000), sc(0.9, 900), 0.05); !v.Bump {
		t.Fatalf("got %+v", v)
	}
}

func TestApplyGolden(t *testing.T) {
	dir := t.TempDir()
	a := entry("o/r", "skills/a/SKILL.md", shaA, "old")
	b := entry("o/r", "skills/b/SKILL.md", shaA, "keep")
	lock := lockOf(t, a, b)
	path := filepath.Join(dir, packs.LockFile)
	if err := packs.WriteLock(path, lock); err != nil {
		t.Fatal(err)
	}
	c := Candidate{Old: a, New: entry("o/r", "skills/a/SKILL.md", shaB, "new")}
	v := Verdict{Bump: true, Reason: "ok"}
	if err := Apply(dir, lock, c, v, sc(0.8, 1000), sc(0.9, 1010)); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(path)
	golden, err := os.ReadFile(filepath.Join("testdata", "apply.lock.golden"))
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(golden) {
		t.Fatalf("lock diff wrong:\n%s\nwant\n%s", after, golden)
	}
	if !strings.Contains(string(after), shaA+"#skills/b/SKILL.md") {
		t.Fatal("untouched entry changed")
	}
	if err := Apply(dir, lock, c, Verdict{Reason: "no"}, sc(0.8, 1000), sc(0.9, 1010)); err == nil {
		t.Fatal("refused verdict must not apply")
	}
}

func TestApplyBodyHasNoOperatorDetail(t *testing.T) {
	dir := t.TempDir()
	a := entry("o/r", "skills/a/SKILL.md", shaA, "old")
	lock := lockOf(t, a)
	c := Candidate{Old: a, New: entry("o/r", "skills/a/SKILL.md", shaB, "new")}
	if err := Apply(dir, lock, c, Verdict{Bump: true, Reason: "ok"}, sc(0.8, 1234), sc(0.9, 1301)); err != nil {
		t.Fatal(err)
	}
	body, err := os.ReadFile(filepath.Join(dir, PRBodyFile))
	if err != nil {
		t.Fatal(err)
	}
	op, err := os.ReadFile(filepath.Join(dir, OperatorFile))
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"1234", "1301", "model-x-9", "okens", "ost", "$"} {
		if strings.Contains(string(body), bad) {
			t.Errorf("PR body contains %q:\n%s", bad, body)
		}
	}
	for _, good := range []string{"1234", "1301", "model-x-9"} {
		if !strings.Contains(string(op), good) {
			t.Errorf("operator file lacks %q", good)
		}
	}
	if !strings.Contains(string(body), "0.80") || !strings.Contains(string(body), "0.90") {
		t.Errorf("PR body lacks pass rates:\n%s", body)
	}
}
