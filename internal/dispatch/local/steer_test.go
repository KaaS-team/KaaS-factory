package local

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/KaaS-team/factory/internal/dispatch/local/input"
	"github.com/jonboulle/clockwork"
)

func steerLocal(t *testing.T, body string, clk clockwork.Clock, closeAfter time.Duration) (*Dispatcher, string) {
	t.Helper()
	wt := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	d, err := New(ctx, Config{
		Worktrees: dirWorktrees{wt}, Binary: script(t, body), Environ: []string{"PATH=" + os.Getenv("PATH")},
		Presets: map[string]Preset{"claude": {Argv: ClaudePreset.Argv, Steer: true}}, Clock: clk, CloseTimeout: closeAfter,
	})
	if err != nil {
		t.Fatal(err)
	}
	return d, wt
}

// steer calls Steer and ticks the fake clock until it returns.
func steer(t *testing.T, d *Dispatcher, clk *clockwork.FakeClock, wt, msg string) {
	t.Helper()
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- d.Steer(context.Background(), s, msg) }()
	for {
		select {
		case err := <-done:
			if err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 400; i++ { // cat has to read before the close signal arrives
				if b, _ := os.ReadFile(filepath.Join(wt, "in.txt")); len(b) > 0 {
					break
				}
				time.Sleep(5 * time.Millisecond)
			}
			cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			if err := d.Cancel(cctx, s); err != nil {
				t.Fatal(err)
			}
			return
		case <-time.After(5 * time.Millisecond):
			clk.Advance(time.Second)
		}
	}
}

// Acceptance (dispatch/local): a multi-line prompt arrives intact, as one bracketed paste.
func TestSteerDeliversMultiLinePromptIntact(t *testing.T) {
	clk := clockwork.NewFakeClock()
	d, wt := steerLocal(t, "cat > in.txt\n", clk, 5*time.Second)
	steer(t, d, clk, wt, "first line\nsecond line\n")
	if got, want := read(t, filepath.Join(wt, "in.txt")), "\x1b[200~first line\nsecond line\x1b[201~"; got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

// Acceptance (dispatch/local): a selection prompt receives raw keys with no paste wrapper.
func TestSteerRawKeysAreNotWrapped(t *testing.T) {
	clk := clockwork.NewFakeClock()
	d, wt := steerLocal(t, "cat > in.txt\n", clk, 5*time.Second)
	steer(t, d, clk, wt, input.RawPrefix+"2\r")
	if got := read(t, filepath.Join(wt, "in.txt")); got != "2\r" {
		t.Fatalf("got %q", got)
	}
}

func TestSteerWithoutSteerPresetIsUnsupported(t *testing.T) {
	d, _ := newLocal(t, "sleep 5\n", nil)
	s, err := d.Dispatch(context.Background(), bf)
	if err != nil {
		t.Fatal(err)
	}
	if err := d.Steer(context.Background(), s, "x"); !errors.Is(err, ErrUnsupported) {
		t.Fatalf("got %v", err)
	}
	_ = d.Cancel(context.Background(), s)
}

// Acceptance (dispatch/local): a process that ignores SIGINT is gone within the close timeout; one that honours it is not killed.
func TestCancelSendsSIGINTThenKills(t *testing.T) {
	for _, c := range []struct{ name, body, marker string }{
		{"honours SIGINT", "trap 'echo got-int > int.txt; exit 0' INT\nwhile :; do sleep 0.05; done\n", "got-int"},
		{"ignores SIGINT", "trap '' INT\nwhile :; do sleep 0.05; done\n", ""},
	} {
		t.Run(c.name, func(t *testing.T) {
			wt := t.TempDir()
			ctx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			d, err := New(ctx, Config{Worktrees: dirWorktrees{wt}, Binary: script(t, c.body), Environ: []string{"PATH=" + os.Getenv("PATH")}, CloseTimeout: 300 * time.Millisecond})
			if err != nil {
				t.Fatal(err)
			}
			s, err := d.Dispatch(context.Background(), bf)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(200 * time.Millisecond) // let the shell install its trap
			start := time.Now()
			cctx, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			if err := d.Cancel(cctx, s); err != nil {
				t.Fatal(err)
			}
			if took := time.Since(start); took > 3*time.Second {
				t.Fatalf("took %v", took)
			}
			if c.marker != "" && read(t, filepath.Join(wt, "int.txt")) != "got-int\n" {
				t.Fatal("SIGINT not delivered first")
			}
		})
	}
}
