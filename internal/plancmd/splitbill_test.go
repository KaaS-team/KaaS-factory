package plancmd

import (
	"bytes"
	"context"
	"os"
	"regexp"
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/plan"
)

const (
	splitbill = "../../tests/fixtures/splitbill"
	rlSpec    = "../plan/testdata/splitbill/rate-limit.spec.md"
	rlGolden  = "../plan/testdata/splitbill/rate-limit.golden"
	rlGoal    = "Add rate limiting to the public API"
)

// goalRun plans the goal against the splitbill fixture; the fake drafter stands in for the agent.
func goalRun(t *testing.T, f Filer, extra ...string) (string, error) {
	t.Helper()
	var gotDir string
	opts := []Option{WithSpecFactory(func(dir string) SpecFunc {
		gotDir = dir
		return func(_ context.Context, goal string) (string, error) {
			if goal != rlGoal {
				t.Errorf("goal = %q", goal)
			}
			return mustRead(t, rlSpec), nil
		}
	})}
	if f != nil {
		opts = append(opts, WithFiler(f))
	}
	c := NewCommand(opts...)
	var out bytes.Buffer
	c.SetOut(&out)
	c.SetErr(&out)
	c.SetArgs(append([]string{rlGoal, "--repo-dir", splitbill}, extra...))
	err := c.ExecuteContext(context.Background())
	if err == nil && gotDir != splitbill {
		t.Errorf("the drafter read %q, want the --repo-dir", gotDir)
	}
	return out.String(), err
}

func TestSplitbillGoldenAndNoSharedFilesInAWave(t *testing.T) {
	out, err := goalRun(t, nil)
	if err != nil {
		t.Fatal(err)
	}
	if os.Getenv("UPDATE_GOLDEN") != "" {
		if err := os.WriteFile(rlGolden, []byte(out), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if want := mustRead(t, rlGolden); out != want {
		t.Fatalf("got:\n%s\nwant:\n%s", out, want)
	}
	// The invariant, read back from the printed markdown, not from the planner.
	var wave string
	seen := map[string]string{}
	var ticket string
	for _, l := range strings.Split(out, "\n") {
		switch {
		case strings.HasPrefix(l, "## Wave"):
			wave, seen = l, map[string]string{}
		case strings.HasPrefix(l, "### "):
			ticket = l
		case strings.HasPrefix(l, "Files: "):
			for _, f := range regexp.MustCompile("`([^`]+)`").FindAllStringSubmatch(l, -1) {
				if other, dup := seen[f[1]]; dup {
					t.Errorf("%s: %s and %s both list %s", wave, other, ticket, f[1])
				}
				seen[f[1]] = ticket
			}
		}
	}
	for _, want := range []string{"**Problem:**", "**Acceptance:**", "Depends on: T1, T2", "```mermaid", "T3 --> T4"} {
		if !strings.Contains(out, want) {
			t.Errorf("output lacks %q", want)
		}
	}
}

func TestRepoDirMustExist(t *testing.T) {
	c := NewCommand()
	c.SetOut(&bytes.Buffer{})
	c.SetErr(&bytes.Buffer{})
	c.SetArgs([]string{rlGoal, "--repo-dir", "no/such/dir"})
	if err := c.ExecuteContext(context.Background()); err == nil || !strings.Contains(err.Error(), "not a directory") {
		t.Fatalf("err = %v", err)
	}
}

func TestSplitbillApproveFilesInDependencyOrderWithMarkers(t *testing.T) {
	f := &fakeFiler{}
	if _, err := goalRun(t, f, "--approve"); err != nil {
		t.Fatal(err)
	}
	var titles []string
	for _, tk := range f.filed {
		titles = append(titles, tk.Title)
		if !strings.HasPrefix(tk.Body, plan.Marker) {
			t.Errorf("%q lacks %s", tk.Title, plan.Marker)
		}
		if !strings.Contains(tk.Body, "\nFiles: ") {
			t.Errorf("%q lacks a Files: line", tk.Title)
		}
	}
	want := []string{"Add a token bucket", "Key each call by client", "Add the rate limit middleware", "Wire the middleware into the server", "Return a clear 429 body"}
	if strings.Join(titles, "|") != strings.Join(want, "|") {
		t.Fatalf("filed order %v", titles)
	}
	// Blocked-by lines point at ids filed earlier: T3 (3rd) waits for #1 and #2, T5 for #3.
	if !strings.Contains(f.filed[2].Body, "Blocked by: #1, #2") || !strings.Contains(f.filed[4].Body, "Blocked by: #3") {
		t.Errorf("blocked-by wrong:\n%s\n%s", f.filed[2].Body, f.filed[4].Body)
	}
}

func TestRefusedPlansExplainThemselves(t *testing.T) {
	for _, tc := range []struct{ name, spec, want string }{
		{"cycle", "testdata/loop.md", "the blocking edges have a cycle"},
		{"duplicate title", "testdata/dup.md", "duplicates the title"},
		{"duplicate key", "testdata/dupkey.md", "is listed twice"},
		{"self loop", "testdata/selfloop.md", "T1 -> T1"},
		{"unknown dep", "testdata/unknowndep.md", "which is no ticket"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeFiler{}
			out, err := run(t, f, "--spec", tc.spec)
			if err != nil || !strings.Contains(out, "Problems:") || !strings.Contains(out, tc.want) {
				t.Fatalf("err=%v out=%s", err, out)
			}
			if strings.Contains(out, "## Wave") {
				t.Errorf("a refused plan printed waves:\n%s", out)
			}
			if _, err := run(t, f, "--spec", tc.spec, "--approve"); err == nil || len(f.filed) != 0 {
				t.Fatalf("approve err=%v filed=%d", err, len(f.filed))
			}
		})
	}
}
