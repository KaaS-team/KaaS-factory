package plan

import (
	"errors"
	"fmt"
	"strings"
)

// Ticket is one planned issue: its handle, title, and the body the dependency, file and acceptance data come from.
type Ticket struct {
	ID         string
	Title      string
	Body       Body
	Files      []string
	Depends    []string
	Acceptance []string
}

// NewTicket parses a planned body into a ticket.
func NewTicket(id, title, body string) (Ticket, error) {
	b, err := ParseBody(body)
	if err != nil {
		return Ticket{}, err
	}
	return Ticket{ID: id, Title: title, Body: b, Files: b.Files(), Depends: b.Deps(), Acceptance: b.Acceptance()}, nil
}

// Plan is a set of tickets whose Depends lines form a graph.
type Plan struct {
	Tickets []Ticket
}

// Problems lists every way the tickets fail as a plan, in the wording of the TS factory; nil when none.
func (p Plan) Problems() []string {
	var out []string
	if len(p.Tickets) == 0 {
		out = append(out, "there are no tickets")
	}
	keys := map[string]bool{}
	titles := map[string]bool{}
	for _, t := range p.Tickets {
		if keys[t.ID] {
			out = append(out, fmt.Sprintf("ticket %s is listed twice", t.ID))
		}
		title := strings.ToLower(strings.TrimSpace(t.Title))
		if titles[title] {
			out = append(out, fmt.Sprintf("ticket %s duplicates the title %q", t.ID, t.Title))
		}
		keys[t.ID], titles[title] = true, true
		if len(t.Files) == 0 {
			out = append(out, fmt.Sprintf("ticket %s lists no Files.", t.ID))
		}
		if len(t.Acceptance) == 0 {
			out = append(out, fmt.Sprintf("ticket %s covers no acceptance criterion", t.ID))
		}
	}
	for _, t := range p.Tickets {
		for _, d := range t.Depends {
			if !keys[d] {
				out = append(out, fmt.Sprintf("ticket %s is blocked by %s, which is no ticket", t.ID, d))
			}
		}
	}
	if c := p.cycle(); c != nil {
		out = append(out, "the blocking edges have a cycle: "+strings.Join(c, " -> "))
	}
	return out
}

func (p Plan) byID() map[string]Ticket {
	m := make(map[string]Ticket, len(p.Tickets))
	for _, t := range p.Tickets {
		if _, ok := m[t.ID]; !ok {
			m[t.ID] = t
		}
	}
	return m
}

// cycle returns the ids of one dependency cycle, or nil. A ticket that depends on itself is a cycle of one.
func (p Plan) cycle() []string {
	by := p.byID()
	state := map[string]int{}
	var stack []string
	var visit func(id string) []string
	visit = func(id string) []string {
		switch state[id] {
		case 2:
			return nil
		case 1:
			for i, s := range stack {
				if s == id {
					return append(append([]string{}, stack[i:]...), id)
				}
			}
		}
		state[id] = 1
		stack = append(stack, id)
		for _, d := range by[id].Depends {
			if _, ok := by[d]; !ok {
				continue
			}
			if c := visit(d); c != nil {
				return c
			}
		}
		stack = stack[:len(stack)-1]
		state[id] = 2
		return nil
	}
	for _, t := range p.Tickets {
		if c := visit(t.ID); c != nil {
			return c
		}
	}
	return nil
}

// Waves groups ticket ids so no wave holds two tickets where one depends on the other or where their
// files overlap. It errors on a cycle or an unknown dependency.
func (p Plan) Waves() ([][]string, error) {
	by := p.byID()
	if c := p.cycle(); c != nil {
		return nil, errors.New("the blocking edges have a cycle: " + strings.Join(c, " -> "))
	}
	var order []string
	seen := map[string]bool{}
	var place func(id string) error
	place = func(id string) error {
		if seen[id] {
			return nil
		}
		seen[id] = true
		for _, d := range by[id].Depends {
			if _, ok := by[d]; !ok {
				return fmt.Errorf("ticket %s is blocked by %s, which is no ticket", id, d)
			}
			if err := place(d); err != nil {
				return err
			}
		}
		order = append(order, id)
		return nil
	}
	for _, t := range p.Tickets {
		if err := place(t.ID); err != nil {
			return nil, err
		}
	}
	level := map[string]int{}
	var waves [][]string
	for _, id := range order {
		t := by[id]
		w := 0
		for _, d := range t.Depends {
			w = max(w, level[d]+1)
		}
		for ; w < len(waves) && conflicts(t, waves[w], by); w++ {
		}
		if w == len(waves) {
			waves = append(waves, nil)
		}
		waves[w] = append(waves[w], id)
		level[id] = w
	}
	return waves, nil
}

func conflicts(t Ticket, wave []string, by map[string]Ticket) bool {
	for _, id := range wave {
		if Overlaps(t.Files, by[id].Files) {
			return true
		}
	}
	return false
}

const shardDir = "tests/mutations/"

func norm(p string) string {
	p = strings.TrimSpace(p)
	p = strings.TrimPrefix(p, "./")
	return strings.TrimRight(p, "/")
}

func pathsOverlap(a, b string) bool {
	if a == b || strings.HasPrefix(a, b+"/") || strings.HasPrefix(b, a+"/") {
		return true
	}
	return strings.HasPrefix(a, shardDir) && strings.HasPrefix(b, shardDir)
}

// Overlaps reports whether any path in a equals, contains or sits under a path in b; every file in
// tests/mutations/ shares one lock. This is the TS area-lock rule from src/batch-plan.ts.
func Overlaps(a, b []string) bool {
	for _, x := range a {
		for _, y := range b {
			if pathsOverlap(norm(x), norm(y)) {
				return true
			}
		}
	}
	return false
}
