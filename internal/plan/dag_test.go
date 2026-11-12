package plan

import (
	"reflect"
	"strings"
	"testing"
)

func body(deps string, files []string, ac bool) string {
	var sb strings.Builder
	sb.WriteString(Marker + "\n")
	if deps != "" {
		sb.WriteString("Deps: " + deps + "\n")
	}
	sb.WriteString("\n## Why\nx\n\n## Acceptance\n")
	if ac {
		sb.WriteString("- AC-1: ok: checked by `t` (T1)\n")
	}
	sb.WriteString("\n## Files\n")
	for _, f := range files {
		sb.WriteString("- `" + f + "`\n")
	}
	return sb.String()
}

func tk(t *testing.T, id, deps string, files ...string) Ticket {
	t.Helper()
	k, err := NewTicket(id, "title "+id, body(deps, files, true))
	if err != nil {
		t.Fatal(err)
	}
	return k
}

func TestProblems(t *testing.T) {
	noAC, _ := NewTicket("c", "title c", body("", []string{"c.go"}, false))
	noFiles, _ := NewTicket("d", "title d", body("", nil, true))
	sameTitle := tk(t, "e", "", "e.go")
	sameTitle.Title = "title a"
	dupKey := tk(t, "a", "", "b.go")
	dupKey.Title = "other"
	cases := []struct {
		name    string
		tickets []Ticket
		want    []string
	}{
		{"valid", nil, nil},
		{"no tickets", nil, []string{"there are no tickets"}},
		{"duplicate key", []Ticket{tk(t, "a", "", "a.go"), dupKey}, []string{"ticket a is listed twice"}},
		{"duplicate title", []Ticket{tk(t, "a", "", "a.go"), sameTitle}, []string{`ticket e duplicates the title "title a"`}},
		{"unknown dep", []Ticket{tk(t, "a", "zz", "a.go")}, []string{"ticket a is blocked by zz, which is no ticket"}},
		{"self cycle", []Ticket{tk(t, "a", "a", "a.go")}, []string{"the blocking edges have a cycle: a -> a"}},
		{"cycle", []Ticket{tk(t, "a", "b", "a.go"), tk(t, "b", "a", "b.go")}, []string{"the blocking edges have a cycle: a -> b -> a"}},
		{"missing files", []Ticket{noFiles}, []string{"ticket d lists no Files."}},
		{"missing acceptance", []Ticket{noAC}, []string{"ticket c covers no acceptance criterion"}},
	}
	for _, c := range cases {
		if c.name == "valid" {
			c.tickets = []Ticket{tk(t, "a", "", "a.go"), tk(t, "b", "a", "b.go")}
		}
		got := Plan{Tickets: c.tickets}.Problems()
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
}

func TestWaves(t *testing.T) {
	cases := []struct {
		name    string
		tickets []Ticket
		want    [][]string
	}{
		{"independent share one wave", []Ticket{tk(t, "a", "", "a.go"), tk(t, "b", "", "b.go"), tk(t, "c", "", "c.go")}, [][]string{{"a", "b", "c"}}},
		{"chain of three", []Ticket{tk(t, "a", "", "a.go"), tk(t, "b", "a", "b.go"), tk(t, "c", "b", "c.go")}, [][]string{{"a"}, {"b"}, {"c"}}},
		{"shared file splits", []Ticket{tk(t, "a", "", "x.go"), tk(t, "b", "", "x.go"), tk(t, "c", "", "y.go")}, [][]string{{"a", "c"}, {"b"}}},
		{"directory is an area lock", []Ticket{tk(t, "a", "", "pkg/a.go"), tk(t, "b", "", "pkg")}, [][]string{{"a"}, {"b"}}},
		{"mutation shards share a lock", []Ticket{tk(t, "a", "", "tests/mutations/a.json"), tk(t, "b", "", "tests/mutations/b.json")}, [][]string{{"a"}, {"b"}}},
		{"dependent order independent of listing", []Ticket{tk(t, "b", "a", "b.go"), tk(t, "a", "", "a.go")}, [][]string{{"a"}, {"b"}}},
		{"conflict bump keeps dependents later", []Ticket{tk(t, "a", "", "x.go"), tk(t, "b", "", "x.go"), tk(t, "c", "b", "c.go")}, [][]string{{"a"}, {"b"}, {"c"}}},
	}
	for _, c := range cases {
		got, err := Plan{Tickets: c.tickets}.Waves()
		if err != nil {
			t.Fatalf("%s: %v", c.name, err)
		}
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: got %v want %v", c.name, got, c.want)
		}
	}
}

func TestWavesRefusesBrokenGraph(t *testing.T) {
	for name, ts := range map[string][]Ticket{
		"cycle":   {tk(t, "a", "b", "a.go"), tk(t, "b", "a", "b.go")},
		"unknown": {tk(t, "a", "q", "a.go")},
	} {
		if _, err := (Plan{Tickets: ts}).Waves(); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}
