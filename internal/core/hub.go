package core

import (
	"context"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

// hub fans events out to subscribers. A send never blocks: a subscriber whose
// buffer is full is closed and removed.
type hub struct {
	mu     sync.Mutex
	buf    int
	now    func() time.Time
	nextID int
	subs   map[int]chan api.Event
	hist   *history
}

func newHub(buf int, now func() time.Time) *hub {
	return &hub{buf: buf, now: now, subs: map[int]chan api.Event{}, hist: newHistory()}
}

// subscribe returns a channel that is closed when ctx ends or the subscriber is dropped.
func (h *hub) subscribe(ctx context.Context) <-chan api.Event {
	ch := make(chan api.Event, h.buf)
	h.mu.Lock()
	id := h.nextID
	h.nextID++
	h.subs[id] = ch
	h.mu.Unlock()
	go func() {
		<-ctx.Done()
		h.mu.Lock()
		defer h.mu.Unlock()
		if _, ok := h.subs[id]; ok {
			delete(h.subs, id)
			close(ch)
		}
	}()
	return ch
}

// emit sends one event to every subscriber, then tells the rest about each drop.
func (h *hub) emit(kind string, id api.TicketID, data map[string]any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	queue := []api.Event{{V: api.EventVersion, Time: h.now(), Kind: kind, Ticket: id, Data: data}}
	for len(queue) > 0 {
		ev := queue[0]
		queue = queue[1:]
		h.hist.add(ev)
		for sid, ch := range h.subs {
			select {
			case ch <- ev:
			default:
				delete(h.subs, sid)
				close(ch)
				queue = append(queue, api.Event{V: api.EventVersion, Time: h.now(), Kind: KindSubscriberDropped, Data: map[string]any{"buffer": h.buf}})
			}
		}
	}
}
