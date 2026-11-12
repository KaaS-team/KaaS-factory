package pick

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/gitx"
)

func tk(id string, prio int, age int, files ...string) api.Ticket {
	return api.Ticket{ID: api.TicketID(id), Priority: prio, CreatedAt: time.Unix(int64(age), 0), Files: files}
}

func ids(ts []api.Ticket) []string {
	out := []string{}
	for _, t := range ts {
		out = append(out, string(t.ID))
	}
	return out
}

func TestRank(t *testing.T) {
	cases := []struct {
		name string
		in   []api.Ticket
		want []string
	}{
		{"priority first", []api.Ticket{tk("a", 2, 1), tk("b", 0, 9)}, []string{"b", "a"}},
		{"oldest next", []api.Ticket{tk("a", 1, 9), tk("b", 1, 2)}, []string{"b", "a"}},
		{"id last", []api.Ticket{tk("b", 1, 2), tk("a", 1, 2)}, []string{"a", "b"}},
		{"zero time sorts last", []api.Ticket{{ID: "a", Priority: 1}, tk("b", 1, 5)}, []string{"b", "a"}},
		{"empty", nil, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := append([]api.Ticket(nil), c.in...)
			if got := ids(Rank(in)); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v want %v", got, c.want)
			}
			if !reflect.DeepEqual(in, c.in) {
				t.Fatal("Rank mutated its input")
			}
		})
	}
}

func TestOverlap(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"src/a.ts", "src/a.ts", true},
		{"src/", "src/a.ts", true},
		{"src", "src/a.ts/x", true},
		{"./src/a.ts", "src/a.ts", true},
		{"src/a.ts", "src/ab.ts", false},
		{"src/a", "src/ab", false},
		{"docs", "src", false},
	}
	for _, c := range cases {
		if got := Overlap([]string{c.a}, []string{c.b}); got != c.want {
			t.Errorf("%q vs %q: got %v", c.a, c.b, got)
		}
		if got := Overlap([]string{c.b}, []string{c.a}); got != c.want {
			t.Errorf("%q vs %q reversed: got %v", c.b, c.a, got)
		}
	}
	if Overlap(nil, []string{"a"}) {
		t.Error("no files must overlap nothing")
	}
}

func TestRefill(t *testing.T) {
	blocked := tk("blk", 0, 1, "z/")
	blocked.BlockedBy = []api.TicketID{"dep"}
	cases := []struct {
		name      string
		free      int
		ranked    []api.Ticket
		running   []api.Ticket
		locks     Locks
		firesLeft int
		want      []string
	}{
		{"free caps", 1, []api.Ticket{tk("a", 0, 1), tk("b", 0, 2)}, nil, Locks{}, 9, []string{"a"}},
		{"fires cap", 5, []api.Ticket{tk("a", 0, 1), tk("b", 0, 2)}, nil, Locks{}, 1, []string{"a"}},
		{"zero fires", 5, []api.Ticket{tk("a", 0, 1)}, nil, Locks{}, 0, []string{}},
		{"negative free", -1, []api.Ticket{tk("a", 0, 1)}, nil, Locks{}, 5, []string{}},
		{"overlap among picked", 3, []api.Ticket{tk("a", 0, 1, "src/a.go"), tk("b", 0, 2, "src/"), tk("c", 0, 3, "docs")}, nil, Locks{}, 9, []string{"a", "c"}},
		{"overlap running", 3, []api.Ticket{tk("a", 0, 1, "src/a.go"), tk("b", 0, 2, "x")}, []api.Ticket{tk("r", 0, 0, "src")}, Locks{}, 9, []string{"b"}},
		{"overlap lock files", 3, []api.Ticket{tk("a", 0, 1, "m/x"), tk("b", 0, 2)}, nil, Locks{Files: []string{"m/"}}, 9, []string{"b"}},
		{"no files never overlaps", 3, []api.Ticket{tk("a", 0, 1), tk("b", 0, 2)}, nil, Locks{}, 9, []string{"a", "b"}},
		{"blocked by unmerged", 3, []api.Ticket{blocked, tk("b", 0, 2)}, nil, Locks{Unmerged: map[api.TicketID]bool{"dep": true}}, 9, []string{"b"}},
		{"blocked by running", 3, []api.Ticket{blocked}, []api.Ticket{tk("dep", 0, 0)}, Locks{}, 9, []string{}},
		{"blocked by ranked", 3, []api.Ticket{blocked, tk("dep", 0, 2)}, nil, Locks{}, 9, []string{"dep"}},
		{"blocker merged", 3, []api.Ticket{blocked}, nil, Locks{}, 9, []string{"blk"}},
		{"already running skipped", 3, []api.Ticket{tk("r", 0, 1)}, []api.Ticket{tk("r", 0, 0)}, Locks{}, 9, []string{}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			picked, _ := Refill(c.free, c.ranked, c.running, c.locks, c.firesLeft)
			got := ids(picked)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}

// Symphony 8.1 (dispatch preflight): an area overlap with an in-flight ticket waits unless the
// two branches really merge clean. This uses real git, not a fake.
func TestRefillMergeTree(t *testing.T) {
	dir := t.TempDir()
	git := func(args ...string) string {
		t.Helper()
		c := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@x", "-c", "commit.gpgsign=false"}, args...)...)
		c.Dir = dir
		c.Env = append(os.Environ(), "GIT_CONFIG_GLOBAL=/dev/null", "GIT_CONFIG_SYSTEM=/dev/null")
		out, err := c.CombinedOutput()
		if err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
		return string(out)
	}
	edit := func(br, file, body string) {
		git("checkout", "-q", "-b", br, "main")
		if err := os.WriteFile(filepath.Join(dir, file), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
		git("commit", "-q", "-am", br)
		git("checkout", "-q", "main")
	}
	git("init", "-q", "-b", "main")
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("1\n2\n3\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "b.txt"), []byte("x\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	git("add", ".")
	git("commit", "-q", "-m", "base")
	edit("run", "a.txt", "1\nrun\n3\n")
	edit("clash", "a.txt", "1\nclash\n3\n")
	edit("clean", "b.txt", "y\n")

	g := gitx.New(dir)
	merge := func(a, b string) ([]string, error) { return g.MergeTree(context.Background(), "main", a, b) }
	running := []api.Ticket{tk("R", 0, 0, "a.txt")}
	cases := []struct {
		name     string
		cand     string // branch of candidate "C", "" for none
		runBr    string
		merge    func(a, b string) ([]string, error)
		want     []string
		wantSkip string
	}{
		{"conflict skips", "clash", "run", merge, []string{}, "C: files overlap R; merge-tree conflicts: a.txt"},
		{"clean merge starts", "clean", "run", merge, []string{"C"}, ""},
		{"no candidate branch skips", "", "run", merge, []string{}, "C: files overlap R"},
		{"no running branch skips", "clean", "", merge, []string{}, "C: files overlap R"},
		{"no Merge skips", "clean", "run", nil, []string{}, "C: files overlap R"},
		{"merge error skips", "nope", "run", merge, []string{}, "C: files overlap R; merge-tree failed: "},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			locks := Locks{Branches: map[api.TicketID]string{}, Merge: c.merge}
			if c.cand != "" {
				locks.Branches["C"] = c.cand
			}
			if c.runBr != "" {
				locks.Branches["R"] = c.runBr
			}
			got, skips := Refill(3, []api.Ticket{tk("C", 0, 1, "a.txt")}, running, locks, 9)
			if !reflect.DeepEqual(ids(got), c.want) {
				t.Fatalf("got %v want %v", ids(got), c.want)
			}
			var line string
			if len(skips) > 0 {
				line = string(skips[0].ID) + ": " + skips[0].Reason
			}
			if !strings.HasPrefix(line, c.wantSkip) || (c.wantSkip == "") != (len(skips) == 0) {
				t.Fatalf("skip %q want prefix %q", line, c.wantSkip)
			}
		})
	}
}

func TestRefillSkipReasons(t *testing.T) {
	blocked := tk("blk", 0, 1)
	blocked.BlockedBy = []api.TicketID{"dep"}
	_, skips := Refill(3, []api.Ticket{blocked, tk("a", 0, 2, "m/x")}, nil, Locks{Files: []string{"m"}, Unmerged: map[api.TicketID]bool{"dep": true}}, 9)
	want := []Skip{{"blk", "blocked by dep"}, {"a", "files overlap a held lock"}}
	if !reflect.DeepEqual(skips, want) {
		t.Fatalf("got %v want %v", skips, want)
	}
}
