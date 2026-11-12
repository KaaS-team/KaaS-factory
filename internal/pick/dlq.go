package pick

import (
	"sort"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// Parked is one ticket held in the dead-letter park.
type Parked struct {
	ID       api.TicketID `json:"id"`
	Failures int          `json:"failures"`
	Reason   string       `json:"reason"`
	At       time.Time    `json:"at"`
}

// DLQ counts unexpected failures per ticket and parks a ticket that reaches the cap.
// It is safe for concurrent use.
type DLQ struct {
	mu       sync.Mutex
	max      int
	failures map[api.TicketID]int
	parked   map[api.TicketID]Parked
}

// NewDLQ returns a DLQ that parks a ticket after cap unexpected failures (at least 1).
func NewDLQ(cap int) *DLQ {
	return &DLQ{max: max(cap, 1), failures: map[api.TicketID]int{}, parked: map[api.TicketID]Parked{}}
}

// Record notes a failed attempt and reports whether the ticket is now parked. A Terminal
// error parks at once, a RateLimited one never counts, anything else counts one.
func (d *DLQ) Record(id api.TicketID, err error, at time.Time) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.parked[id]; ok {
		return true
	}
	switch Classify(err) {
	case ClassRateLimited:
		return false
	case ClassTerminal:
		d.failures[id] = d.max
	default:
		d.failures[id]++
	}
	if d.failures[id] < d.max {
		return false
	}
	reason := ""
	if err != nil {
		reason = err.Error()
	}
	d.parked[id] = Parked{ID: id, Failures: d.failures[id], Reason: reason, At: at}
	return true
}

// Parked reports whether id is parked.
func (d *DLQ) Parked(id api.TicketID) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, ok := d.parked[id]
	return ok
}

// Clear forgets the failure count of id after a success.
func (d *DLQ) Clear(id api.TicketID) {
	d.mu.Lock()
	defer d.mu.Unlock()
	delete(d.failures, id)
}

// Requeue takes id out of the park and resets its count; false if it was not parked.
func (d *DLQ) Requeue(id api.TicketID) bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	if _, ok := d.parked[id]; !ok {
		return false
	}
	delete(d.parked, id)
	delete(d.failures, id)
	return true
}

// List returns the parked tickets, oldest park first, then by id.
func (d *DLQ) List() []Parked {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make([]Parked, 0, len(d.parked))
	for _, p := range d.parked {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].At.Equal(out[j].At) {
			return out[i].At.Before(out[j].At)
		}
		return out[i].ID < out[j].ID
	})
	return out
}

// Set returns the parked ids, for Locks.Parked.
func (d *DLQ) Set() map[api.TicketID]bool {
	d.mu.Lock()
	defer d.mu.Unlock()
	out := make(map[api.TicketID]bool, len(d.parked))
	for id := range d.parked {
		out[id] = true
	}
	return out
}
