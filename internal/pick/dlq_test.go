package pick

import (
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

func TestDLQRecord(t *testing.T) {
	boom := errors.New("boom")
	cases := []struct {
		name   string
		errs   []error
		parked bool
	}{
		{"under the cap", []error{boom, boom}, false},
		{"cap reached", []error{boom, boom, boom}, true},
		{"terminal parks at once", []error{Terminal(boom)}, true},
		{"rate limited never counts", []error{RateLimited(boom, 0), RateLimited(boom, 0), RateLimited(boom, 0), RateLimited(boom, 0)}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			d := NewDLQ(3)
			var got bool
			for _, e := range c.errs {
				got = d.Record("T1", e, time.Unix(5, 0))
			}
			if got != c.parked || d.Parked("T1") != c.parked {
				t.Fatalf("Record=%v Parked=%v want %v", got, d.Parked("T1"), c.parked)
			}
		})
	}
}

func TestDLQRequeueAndList(t *testing.T) {
	d := NewDLQ(2)
	d.Record("B", Terminal(errors.New("b fail")), time.Unix(2, 0))
	d.Record("A", Terminal(errors.New("a fail")), time.Unix(1, 0))
	got := d.List()
	want := []Parked{{ID: "A", Failures: 2, Reason: "a fail", At: time.Unix(1, 0)}, {ID: "B", Failures: 2, Reason: "b fail", At: time.Unix(2, 0)}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	if !d.Requeue("A") || d.Requeue("A") || d.Parked("A") {
		t.Fatal("requeue should succeed once and clear the park")
	}
	// A requeued ticket starts counting from zero.
	if d.Record("A", errors.New("again"), time.Unix(3, 0)) {
		t.Fatal("one new failure of a cap of 2 must not park")
	}
}

func TestDLQSuccessResetsCount(t *testing.T) {
	d := NewDLQ(2)
	d.Record("T", errors.New("x"), time.Unix(1, 0))
	d.Clear("T")
	if d.Record("T", errors.New("x"), time.Unix(2, 0)) {
		t.Fatal("count should have reset")
	}
}

// Symphony 8.1: a ticket parked in the DLQ is passed over by Refill and reported as a skip.
func TestRefillSkipsParked(t *testing.T) {
	ranked := []api.Ticket{tk("a", 0, 1), tk("b", 0, 2)}
	out, skips := Refill(2, ranked, nil, Locks{Parked: map[api.TicketID]bool{"a": true}}, 2)
	if got := ids(out); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("picked %v", got)
	}
	if len(skips) != 1 || skips[0].ID != "a" || skips[0].Reason != "parked in DLQ" {
		t.Fatalf("skips %+v", skips)
	}
}
