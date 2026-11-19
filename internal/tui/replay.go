package tui

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
)

var errReplay = errors.New("replay is read-only")

// Replay is an api.Control that plays a recorded `factory run --headless` stream. It folds each
// event into a board, so the model sees the same Board and Events calls it sees on a live fleet.
type Replay struct {
	mu      sync.Mutex
	events  []api.Event
	next    int
	skipped int
	speed   float64
	sleep   func(time.Duration)
	clock   time.Time
	board   api.Board
	started map[api.TicketID]time.Time
}

var _ api.Control = (*Replay)(nil)

// NewReplay reads NDJSON events from r. A line that is not an event is skipped and counted.
// speed scales the gaps between events; zero or less plays with no wait.
func NewReplay(r io.Reader, speed float64) (*Replay, error) {
	p := &Replay{speed: speed, sleep: time.Sleep, started: map[api.TicketID]time.Time{}}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64*1024), 4*1024*1024)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var e api.Event
		if err := json.Unmarshal(line, &e); err != nil || e.Kind == "" || e.Time.IsZero() {
			p.skipped++
			continue
		}
		p.events = append(p.events, e)
	}
	return p, sc.Err()
}

// Skipped is how many lines were not events.
func (p *Replay) Skipped() int { return p.skipped }

// Now is the time of the newest event played, the board's clock.
func (p *Replay) Now() time.Time {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.clock
}

// Next folds the next recorded event into the board and returns it.
func (p *Replay) Next() (api.Event, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.next >= len(p.events) {
		return api.Event{}, false
	}
	e := p.events[p.next]
	p.next++
	p.clock = e.Time
	p.fold(e)
	return e, true
}

// fold is the reducer from event to board. Kinds it does not know change nothing.
func (p *Replay) fold(e api.Event) {
	b := &p.board
	id := e.Ticket
	i := slices.IndexFunc(b.Slots, func(s api.Slot) bool { return s.Ticket.ID == id })
	switch e.Kind {
	case "dispatched":
		title, _ := e.Data["title"].(string)
		s := api.Slot{
			Ticket:  api.Ticket{ID: id, Title: title},
			Phase:   api.PhaseRunning,
			Session: &api.Session{Ticket: id, StartedAt: e.Time},
			Budget:  api.Budget{Tokens: num(e.Data["budget"])},
		}
		if i >= 0 {
			b.Slots[i] = s
		} else {
			b.Slots = append(b.Slots, s)
		}
	case "pushed":
		if i >= 0 {
			s := &b.Slots[i]
			s.LastPush, s.Phase = e.Time, api.PhaseRunning
			s.Usage.InputTokens = num(e.Data["tokens"])
		}
	case "stalled":
		if i >= 0 {
			b.Slots[i].Phase = api.PhaseStalled
		}
	case "queued":
		if i >= 0 {
			b.Slots = slices.Delete(b.Slots, i, i+1)
		}
		b.MergeQueue = append(b.MergeQueue, id)
	case "merged":
		b.MergeQueue = slices.DeleteFunc(b.MergeQueue, func(x api.TicketID) bool { return x == id })
	}
}

func num(v any) int64 {
	f, _ := v.(float64)
	return int64(f)
}

// Board returns a copy of the folded state.
func (p *Replay) Board(context.Context) (api.Board, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	b := p.board
	b.Slots = slices.Clone(b.Slots)
	b.MergeQueue = slices.Clone(b.MergeQueue)
	return b, nil
}

// Events plays the rest of the recording, waiting gap/speed between events, then closes.
func (p *Replay) Events(ctx context.Context) (<-chan api.Event, error) {
	ch := make(chan api.Event)
	go func() {
		defer close(ch)
		var prev time.Time
		for {
			p.mu.Lock()
			var gap time.Duration
			if p.next < len(p.events) && !prev.IsZero() {
				gap = p.events[p.next].Time.Sub(prev)
			}
			p.mu.Unlock()
			if p.speed > 0 && gap > 0 {
				p.sleep(time.Duration(float64(gap) / p.speed))
			}
			e, ok := p.Next()
			if !ok {
				return
			}
			prev = e.Time
			select {
			case ch <- e:
			case <-ctx.Done():
				return
			}
		}
	}()
	return ch, nil
}

// Dispatch, Steer, Cancel, Retry, CreateTicket, HandOff and QueueFollowup refuse: a replay only shows.
func (*Replay) Dispatch(context.Context, api.TicketID) error { return errReplay }

func (*Replay) Steer(context.Context, api.TicketID, string) error { return errReplay }

func (*Replay) Cancel(context.Context, api.TicketID) error { return errReplay }

func (*Replay) Retry(context.Context, api.TicketID) error { return errReplay }

func (*Replay) CreateTicket(context.Context, string, string) (api.TicketID, error) {
	return "", errReplay
}

func (*Replay) HandOff(context.Context, api.TicketID, string, string) error { return errReplay }

func (*Replay) QueueFollowup(context.Context, api.TicketID, string) error { return errReplay }

// Repos has nothing to list.
func (*Replay) Repos(context.Context) ([]string, error) { return nil, nil }
