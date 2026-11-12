package input

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jonboulle/clockwork"
)

func TestRingBufferKeepsNewestOldestFirst(t *testing.T) {
	r := NewRingBuffer[int](3)
	for i := 1; i <= 5; i++ {
		r.Add(i)
	}
	got := r.GetAll()
	if len(got) != 3 || got[0] != 3 || got[2] != 5 {
		t.Fatalf("got %v", got)
	}
}

// Acceptance (steer queue): send only when the last N snapshots are identical, driven by a fake clock.
func TestGateSendsOnlyWhenSnapshotsAreIdentical(t *testing.T) {
	snaps := []string{"a", "b", "c", "c", "d", "d", "d"}
	var n atomic.Int32
	snap := func() string { i := int(n.Add(1)) - 1; return snaps[min(i, len(snaps)-1)] }
	clk := clockwork.NewFakeClock()
	var out bytes.Buffer
	q := &Queue{Out: &out, Snapshot: snap, Window: 3, Every: time.Second, Clock: clk}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- q.Send(ctx, "hi") }()
	for i := 0; i < 6; i++ { // snapshots 2..7; the third "d" is the seventh
		for n.Load() < int32(i+1) {
			time.Sleep(time.Millisecond)
		}
		_ = clk.BlockUntilContext(ctx, 1)
		select {
		case err := <-done:
			t.Fatalf("sent after only %d snapshots (err %v); out %q", n.Load(), err, out.String())
		default:
		}
		clk.Advance(time.Second)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if n.Load() != 7 || out.String() != "\x1b[200~hi\x1b[201~" {
		t.Fatalf("snapshots %d out %q", n.Load(), out.String())
	}
}

func TestSendStopsWhenContextEnds(t *testing.T) {
	var i atomic.Int32
	clk := clockwork.NewFakeClock()
	var out bytes.Buffer
	q := &Queue{Out: &out, Snapshot: func() string { return strings.Repeat("x", int(i.Add(1))) }, Window: 2, Every: time.Second, Clock: clk}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- q.Send(ctx, "x") }()
	_ = clk.BlockUntilContext(context.Background(), 1)
	cancel()
	if err := <-done; err == nil || out.Len() != 0 {
		t.Fatalf("err %v out %q", err, out.String())
	}
}

// Acceptance (dispatch/local): a multi-line prompt arrives as one bracketed paste, and a selection prompt gets raw keys.
func TestFrame(t *testing.T) {
	for _, c := range []struct{ name, in, want string }{
		{"multi-line paste", "line one\nline two\n", "\x1b[200~line one\nline two\x1b[201~"},
		{"raw keys have no escape wrapper", RawPrefix + "2\r", "2\r"},
		{"raw arrow key", RawPrefix + "\x1b[B", "\x1b[B"},
	} {
		if got := Frame(c.in); got != c.want {
			t.Errorf("%s: got %q want %q", c.name, got, c.want)
		}
	}
	if strings.Contains(Frame(RawPrefix+"1"), "\x1b[200~") {
		t.Error("raw input must not be bracketed")
	}
}

// Acceptance: the process is gone within the timeout; SIGINT first, the kill only if it ignores it.
func TestClose(t *testing.T) {
	for _, c := range []struct {
		name             string
		exitsOnInterrupt bool
		interruptErr     error
		wantKill         bool
	}{
		{"exits on interrupt", true, nil, false},
		{"ignores interrupt", false, nil, true},
		{"interrupt fails", false, errors.New("fake"), true},
	} {
		t.Run(c.name, func(t *testing.T) {
			clk := clockwork.NewFakeClock()
			done := make(chan struct{})
			killed := false
			interrupt := func() error {
				if c.exitsOnInterrupt {
					close(done)
				}
				return c.interruptErr
			}
			kill := func() error { killed = true; close(done); return nil }
			res := make(chan error, 1)
			go func() { res <- Close(context.Background(), clk, interrupt, kill, done, 5*time.Second) }()
			if !c.exitsOnInterrupt && c.interruptErr == nil {
				_ = clk.BlockUntilContext(context.Background(), 1)
				clk.Advance(5 * time.Second)
			}
			if err := <-res; err != nil {
				t.Fatal(err)
			}
			if killed != c.wantKill {
				t.Fatalf("killed=%v want %v", killed, c.wantKill)
			}
		})
	}
}
