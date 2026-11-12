package pick

import (
	"fmt"
	"reflect"
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

func rt(id, repo string, age int) api.Ticket {
	t := tk(id, 1, age)
	t.Repo = repo
	return t
}

// Symphony 8.3 bounds concurrency; the cap is per repo on top of it.
func TestFairCapHoldsOneRepoToItsCap(t *testing.T) {
	var ranked []api.Ticket
	for i := 0; i < 100; i++ {
		ranked = append(ranked, rt(fmt.Sprintf("a%03d", i), "A", i))
	}
	ranked = append(ranked, rt("b1", "B", 500))
	f := NewFair(1, 4, 2)
	got, skips := Refill(10, ranked, nil, Locks{Fair: f}, 10)
	perRepo := map[string]int{}
	for _, g := range got {
		perRepo[g.Repo]++
	}
	if perRepo["A"] != 2 || perRepo["B"] != 1 {
		t.Fatalf("per repo %v, want A=2 B=1", perRepo)
	}
	if len(skips) == 0 || skips[0].Reason != "repo A at cap 2" {
		t.Fatalf("skips %v", skips)
	}
}

func TestFairCapCountsRunning(t *testing.T) {
	running := []api.Ticket{rt("r1", "A", 0), rt("r2", "A", 0)}
	got, _ := Refill(5, []api.Ticket{rt("a3", "A", 3), rt("b1", "B", 4)}, running, Locks{Fair: NewFair(1, 4, 2)}, 5)
	if !reflect.DeepEqual(ids(got), []string{"b1"}) {
		t.Fatalf("got %v", ids(got))
	}
}

func TestFairOtherRepoGetsSlotWithinOneRound(t *testing.T) {
	var ranked []api.Ticket
	for i := 0; i < 20; i++ {
		ranked = append(ranked, rt(fmt.Sprintf("a%02d", i), "A", i))
	}
	ranked = append(ranked, rt("b1", "B", 99), rt("c1", "C", 99))
	got, _ := Refill(3, ranked, nil, Locks{Fair: NewFair(1, 4, 0)}, 3)
	if !reflect.DeepEqual(ids(got), []string{"a00", "b1", "c1"}) {
		t.Fatalf("got %v", ids(got))
	}
}

func TestFairDeficitFavoursRepoServedLess(t *testing.T) {
	f := NewFair(1, 4, 0)
	ranked := []api.Ticket{rt("a1", "A", 1), rt("a2", "A", 2), rt("b1", "B", 3), rt("b2", "B", 4)}
	first, _ := Refill(1, ranked, nil, Locks{Fair: f}, 1)
	if ids(first)[0] != "a1" {
		t.Fatalf("first %v", ids(first))
	}
	second, _ := Refill(1, ranked[1:], nil, Locks{Fair: f}, 1)
	if ids(second)[0] != "b1" {
		t.Fatalf("second %v, B was served less", ids(second))
	}
}

func TestFairDeficitIsCappedAndForgotten(t *testing.T) {
	f := NewFair(1, 3, 0)
	for i := 0; i < 10; i++ {
		f.Round([]string{"B"})
	}
	if d := f.deficit["B"]; d != 3 {
		t.Fatalf("deficit %v want cap 3", d)
	}
	f.Round([]string{"A"})
	if _, ok := f.deficit["B"]; ok {
		t.Fatal("inactive repo keeps deficit")
	}
}

func TestFairNilKeepsRankOrder(t *testing.T) {
	ranked := []api.Ticket{rt("a1", "A", 1), rt("a2", "A", 2), rt("b1", "B", 3)}
	got, _ := Refill(3, ranked, nil, Locks{}, 3)
	if !reflect.DeepEqual(ids(got), []string{"a1", "a2", "b1"}) {
		t.Fatalf("got %v", ids(got))
	}
}
