package pick

import (
	"reflect"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
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
			got := ids(Refill(c.free, c.ranked, c.running, c.locks, c.firesLeft))
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("got %v want %v", got, c.want)
			}
		})
	}
}
