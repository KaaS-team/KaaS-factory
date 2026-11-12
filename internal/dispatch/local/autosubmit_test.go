package local

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/local/autosubmit"
)

type recordPRs struct{ got []autosubmit.PR }

func (r *recordPRs) Open(_ context.Context, p autosubmit.PR) (string, error) {
	r.got = append(r.got, p)
	return "https://example.test/pr/1", nil
}

func git(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@t"}, args...)...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
}

// partialRun runs a fake agent in a real worktree whose origin is a bare repo.
func partialRun(t *testing.T, body string, caps autosubmit.Caps) (*Dispatcher, api.Session, *recordPRs, string) {
	t.Helper()
	root := t.TempDir()
	origin, wt := filepath.Join(root, "o.git"), filepath.Join(root, "wt")
	git(t, root, "init", "-q", "--bare", "-b", "main", origin)
	git(t, root, "clone", "-q", origin, wt)
	if err := os.WriteFile(filepath.Join(wt, "a"), []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	git(t, wt, "add", "-A")
	git(t, wt, "commit", "-q", "-m", "seed")
	git(t, wt, "push", "-q", "origin", "HEAD:main")
	git(t, wt, "checkout", "-q", "-b", bf.Branch)
	prs := &recordPRs{}
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := New(ctx, Config{
		Worktrees: dirWorktrees{wt}, Binary: script(t, body), Environ: []string{"PATH=" + os.Getenv("PATH")},
		Autosubmit: &autosubmit.Submitter{Caps: caps, PRs: prs},
	})
	if err != nil {
		t.Fatal(err)
	}
	s, err := d.Dispatch(ctx, bf)
	if err != nil {
		t.Fatal(err)
	}
	return d, s, prs, wt
}

const loop = `echo work > out.txt
i=0
while [ $i -lt 100 ]; do
  echo '{"type":"assistant","message":{"usage":{"output_tokens":1}}}'
  echo "$i" >> calls.log
  i=$((i+1))
  sleep 0.05
done
`

// Acceptance: a forced call-cap breach yields a partial PR, and the run overruns the cap by at most CallMargin.
func TestCallCapBreachOpensAPartialPRWithinTheMargin(t *testing.T) {
	d, s, prs, wt := partialRun(t, loop, autosubmit.Caps{Calls: 3})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	_ = d.Wait(ctx, s)
	if len(prs.got) != 1 || !strings.Contains(prs.got[0].Body, autosubmit.Marker) {
		t.Fatalf("prs: %+v", prs.got)
	}
	// calls.log was committed into the partial diff, so its line count is what the agent got to.
	n := strings.Count(read(t, filepath.Join(wt, "calls.log")), "\n")
	if n > 3+autosubmit.CallMargin {
		t.Errorf("agent made %d calls, cap 3 with margin %d", n, autosubmit.CallMargin)
	}
	if url, err := d.Autosubmitted(s); err != nil || url == "" {
		t.Errorf("Autosubmitted: %q %v", url, err)
	}
}

// Acceptance: a session that dies on its own is submitted too; a clean exit and an operator Cancel are not.
func TestAbnormalExitRows(t *testing.T) {
	cases := []struct {
		name   string
		body   string
		cancel bool
		want   int
	}{
		{"crash", "echo work > out.txt\nexit 3\n", false, 1},
		{"clean exit", "echo work > out.txt\nexit 0\n", false, 0},
		{"operator cancel", "echo work > out.txt\nsleep 30\n", true, 0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d, s, prs, _ := partialRun(t, c.body, autosubmit.Caps{})
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			if c.cancel {
				time.Sleep(300 * time.Millisecond)
				if err := d.Cancel(ctx, s); err != nil {
					t.Fatal(err)
				}
			}
			_ = d.Wait(ctx, s)
			if len(prs.got) != c.want {
				t.Errorf("prs: %+v, want %d", prs.got, c.want)
			}
		})
	}
}

// The loop guard sees every line first; a run it lets through must still reach the autosubmit guard,
// so a shadowed or skipped guard would show here as no partial PR.
func TestAutosubmitGuardFiresWhileLoopGuardIsActive(t *testing.T) {
	varied := `i=0
while [ $i -lt 100 ]; do
  echo "{\"type\":\"assistant\",\"message\":{\"content\":\"step $i\"}}"
  echo work$i > f$i.txt
  i=$((i+1))
  sleep 0.05
done
`
	d, s, prs, _ := partialRun(t, varied, autosubmit.Caps{Calls: 4})
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	err := d.Wait(ctx, s)
	if errors.Is(err, ErrStuck) {
		t.Fatalf("varied run was aborted as stuck: %v", err)
	}
	if len(prs.got) != 1 {
		t.Fatalf("prs: %+v, want the call cap to open one partial PR", prs.got)
	}
}
