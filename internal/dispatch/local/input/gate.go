// Package input delivers text to a running agent's terminal: it waits for the screen to settle,
// frames the text as a bracketed paste or raw keys, and closes the agent with SIGINT before a kill.
package input

import (
	"context"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/jonboulle/clockwork"
)

// RawPrefix starts a steer message whose rest is sent as typed keys. A selection prompt reads ESC
// as cancel, so it must not get a paste.
const RawPrefix = "\x00raw\x00"

// Frame turns a steer message into the bytes to write: raw keys as they are, anything else as one
// bracketed paste so a multi-line prompt arrives intact.
func Frame(msg string) string {
	if keys, ok := strings.CutPrefix(msg, RawPrefix); ok {
		return keys
	}
	return "\x1b[200~" + strings.TrimSpace(msg) + "\x1b[201~"
}

// Queue writes framed messages to Out, one at a time, once Snapshot has returned the same text for
// Window samples in a row, Every apart.
type Queue struct {
	Out      io.Writer
	Snapshot func() string
	Window   int
	Every    time.Duration
	Clock    clockwork.Clock

	mu sync.Mutex
}

// Send waits for the screen to be stable, then writes Frame(msg). It stops with ctx's error if ctx ends first.
func (q *Queue) Send(ctx context.Context, msg string) error {
	q.mu.Lock()
	defer q.mu.Unlock()
	ring := NewRingBuffer[string](q.Window)
	tick := q.Clock.NewTicker(q.Every)
	defer tick.Stop()
	for {
		ring.Add(q.Snapshot())
		if stable(ring.GetAll(), q.Window) {
			_, err := io.WriteString(q.Out, Frame(msg))
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-tick.Chan():
		}
	}
}

func stable(s []string, n int) bool {
	if len(s) < n {
		return false
	}
	for _, v := range s {
		if v != s[0] {
			return false
		}
	}
	return true
}

// Tail is an io.Writer that keeps the last Max bytes written, as the agent's visible screen.
type Tail struct {
	Max int

	mu  sync.Mutex
	buf []byte
}

// Write appends p and drops the oldest bytes beyond Max.
func (t *Tail) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.Max {
		t.buf = t.buf[len(t.buf)-t.Max:]
	}
	return len(p), nil
}

// String returns the bytes kept so far.
func (t *Tail) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}

// Close sends the interrupt, waits up to timeout for done, then kills. It returns once done is closed
// or kill has been called. Close is the part of agentapi's Process.Close that does not need a pty.
func Close(ctx context.Context, clk clockwork.Clock, interrupt, kill func() error, done <-chan struct{}, timeout time.Duration) error {
	if interrupt() == nil {
		select {
		case <-done:
			return nil
		case <-clk.After(timeout):
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return kill()
}
