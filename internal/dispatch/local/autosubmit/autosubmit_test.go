package autosubmit

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

const assistant = `{"type":"assistant","message":{"usage":{"input_tokens":1}}}`

// Symphony §8.4 (stall and stop handling): a run that passes a cap is stopped at the first line that shows it.
func TestGuardFeedRows(t *testing.T) {
	cases := []struct {
		name  string
		caps  Caps
		lines []string
		want  Reason
		calls int
	}{
		{"no caps never trips", Caps{}, []string{assistant, assistant, assistant}, "", 3},
		{"under the call cap", Caps{Calls: 3}, []string{assistant, assistant}, "", 2},
		{"call cap reached", Caps{Calls: 2}, []string{assistant, assistant, assistant}, CallCap, 2},
		{"non-assistant lines are not calls", Caps{Calls: 1}, []string{`{"type":"system"}`, `not json`, `{"type":"user"}`}, "", 0},
		{"cost cap reached by a result line", Caps{USD: 1}, []string{assistant, `{"type":"result","total_cost_usd":1.5}`}, CostCap, 1},
		{"cost under cap", Caps{USD: 2}, []string{`{"type":"result","total_cost_usd":1.5}`}, "", 0},
		{"cost falls back to cost_usd", Caps{USD: 1}, []string{`{"type":"result","cost_usd":1}`}, CostCap, 0},
		{"unknown cost never trips", Caps{USD: 0.01}, []string{assistant, `{"type":"result"}`}, "", 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			g := Guard{caps: c.caps}
			var got Reason
			for _, l := range c.lines {
				if r := g.Feed([]byte(l)); r != "" {
					got = r
					break
				}
			}
			if got != c.want || g.Calls() != c.calls {
				t.Errorf("reason %q calls %d, want %q %d", got, g.Calls(), c.want, c.calls)
			}
		})
	}
}

type fakePRs struct {
	got []PR
	err error
}

func (f *fakePRs) Open(_ context.Context, p PR) (string, error) {
	f.got = append(f.got, p)
	return "https://example.test/pr/1", f.err
}

func sh(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

// repo returns a worktree on factory/7-a1 cut from origin/main, and the bare origin.
func repo(t *testing.T) (wt, origin string) {
	t.Helper()
	root := t.TempDir()
	origin = filepath.Join(root, "origin.git")
	seed := filepath.Join(root, "seed")
	wt = filepath.Join(root, "wt")
	sh(t, root, "init", "-q", "--bare", "-b", "main", origin)
	sh(t, root, "init", "-q", "-b", "main", seed)
	if err := os.WriteFile(filepath.Join(seed, "a.txt"), []byte("a\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	sh(t, seed, "add", "-A")
	sh(t, seed, "commit", "-q", "-m", "seed")
	sh(t, seed, "push", "-q", origin, "main")
	sh(t, root, "clone", "-q", origin, wt)
	sh(t, wt, "checkout", "-q", "-b", "factory/7-a1")
	return wt, origin
}

var exit = api.Brief{Ticket: "7", Attempt: 1, Repo: "o/r", Base: "main", Branch: "factory/7-a1"}

// Acceptance: a forced budget breach yields a partial PR carrying the diff.
func TestSubmitPushesTheDiffAndOpensAPartialPR(t *testing.T) {
	wt, origin := repo(t)
	if err := os.WriteFile(filepath.Join(wt, "new.txt"), []byte("work\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	prs := &fakePRs{}
	s := &Submitter{Caps: Caps{Calls: 9, USD: 4.5}, PRs: prs}
	url, err := s.Submit(context.Background(), Exit{Brief: exit, Dir: wt, Reason: CallCap})
	if err != nil || url == "" {
		t.Fatalf("submit: %q %v", url, err)
	}
	if sh(t, origin, "show", "factory/7-a1:new.txt") != "work" {
		t.Error("the branch on origin lacks the diff")
	}
	if len(prs.got) != 1 {
		t.Fatalf("prs: %+v", prs.got)
	}
	p := prs.got[0]
	if p.Repo != "o/r" || p.Head != "factory/7-a1" || p.Base != "main" || !p.Draft {
		t.Errorf("pr: %+v", p)
	}
	if !strings.HasPrefix(p.Title, "[partial] ") || !strings.Contains(p.Body, Marker) {
		t.Errorf("pr is not marked partial: %q / %q", p.Title, p.Body)
	}
}

// Acceptance: caps and spend never reach a PR body.
func TestPRBodyHasNoCapsOrSpend(t *testing.T) {
	wt, _ := repo(t)
	if err := os.WriteFile(filepath.Join(wt, "n"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	prs := &fakePRs{}
	s := &Submitter{Caps: Caps{Calls: 777, USD: 4.25}, PRs: prs}
	for _, r := range []Reason{CallCap, CostCap, Died} {
		if _, err := s.Submit(context.Background(), Exit{Brief: exit, Dir: wt, Reason: r}); err != nil {
			t.Fatal(err)
		}
	}
	for _, p := range prs.got {
		for _, bad := range []string{"777", "4.25", "$", "USD", "cost", "token", "budget", "claude", "sonnet", "opus"} {
			if strings.Contains(strings.ToLower(p.Title+p.Body), strings.ToLower(bad)) {
				t.Errorf("pr text has %q: %s", bad, p.Body)
			}
		}
	}
}

func TestSubmitRows(t *testing.T) {
	t.Run("no changes opens nothing", func(t *testing.T) {
		wt, _ := repo(t)
		prs := &fakePRs{}
		_, err := (&Submitter{PRs: prs}).Submit(context.Background(), Exit{Brief: exit, Dir: wt, Reason: Died})
		if !errors.Is(err, ErrNothing) || len(prs.got) != 0 {
			t.Errorf("err %v prs %v", err, prs.got)
		}
	})
	t.Run("work the agent already committed is submitted", func(t *testing.T) {
		wt, _ := repo(t)
		if err := os.WriteFile(filepath.Join(wt, "c.txt"), []byte("c"), 0o644); err != nil {
			t.Fatal(err)
		}
		sh(t, wt, "add", "-A")
		sh(t, wt, "commit", "-q", "-m", "agent")
		prs := &fakePRs{}
		if _, err := (&Submitter{PRs: prs}).Submit(context.Background(), Exit{Brief: exit, Dir: wt, Reason: Died}); err != nil || len(prs.got) != 1 {
			t.Errorf("err %v prs %v", err, prs.got)
		}
	})
	t.Run("a failing hook does not block the partial commit", func(t *testing.T) {
		wt, _ := repo(t)
		hook := filepath.Join(wt, ".git", "hooks", "pre-commit")
		if err := os.WriteFile(hook, []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(wt, "h"), []byte("h"), 0o644); err != nil {
			t.Fatal(err)
		}
		if _, err := (&Submitter{PRs: &fakePRs{}}).Submit(context.Background(), Exit{Brief: exit, Dir: wt, Reason: Died}); err != nil {
			t.Errorf("hook blocked: %v", err)
		}
	})
	t.Run("a PR error is returned", func(t *testing.T) {
		wt, _ := repo(t)
		if err := os.WriteFile(filepath.Join(wt, "e"), []byte("e"), 0o644); err != nil {
			t.Fatal(err)
		}
		boom := errors.New("boom")
		if _, err := (&Submitter{PRs: &fakePRs{err: boom}}).Submit(context.Background(), Exit{Brief: exit, Dir: wt, Reason: Died}); !errors.Is(err, boom) {
			t.Errorf("err %v", err)
		}
	})
}
