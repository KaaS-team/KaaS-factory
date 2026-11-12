package sandbox

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func newBox(t *testing.T, lc Lifecycle) *Box {
	t.Helper()
	root := t.TempDir()
	wd := filepath.Join(root, "wd")
	if err := os.MkdirAll(wd, 0o755); err != nil {
		t.Fatal(err)
	}
	b, err := NewBox(lc, wd, filepath.Join(root, "snap"))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func write(t *testing.T, p, s string) {
	t.Helper()
	if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLifecycleValidate(t *testing.T) {
	tests := []struct {
		name string
		lc   Lifecycle
		ok   bool
	}{
		{"zero value is kill", Lifecycle{}, true},
		{"pause with filesystem", Lifecycle{OnTimeout: OnTimeoutPause, PauseMode: PauseFilesystem}, true},
		{"pause defaults mode", Lifecycle{OnTimeout: OnTimeoutPause}, true},
		{"unknown onTimeout", Lifecycle{OnTimeout: "sleep"}, false},
		{"unknown pauseMode", Lifecycle{OnTimeout: OnTimeoutPause, PauseMode: "memory"}, false},
		{"autoResume needs pause", Lifecycle{AutoResume: true}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := NewBox(tc.lc, "w", "s"); (err == nil) != tc.ok {
				t.Fatalf("err = %v, ok want %v", err, tc.ok)
			}
		})
	}
}

func TestPauseResumeKeepsWorkdir(t *testing.T) {
	b := newBox(t, Lifecycle{OnTimeout: OnTimeoutPause})
	write(t, filepath.Join(b.workdir, "a.txt"), "kept")
	if err := b.Pause(); err != nil || b.State() != Paused {
		t.Fatalf("Pause: %v state %v", err, b.State())
	}
	if err := os.RemoveAll(b.workdir); err != nil {
		t.Fatal(err)
	}
	res, err := b.Resume()
	if err != nil || b.State() != Running {
		t.Fatalf("Resume: %v state %v", err, b.State())
	}
	if res.PauseMode != PauseFilesystem {
		t.Fatalf("PauseMode = %q", res.PauseMode)
	}
	got, _ := os.ReadFile(filepath.Join(b.workdir, "a.txt"))
	if string(got) != "kept" {
		t.Fatalf("workdir file = %q", got)
	}
}

func TestIllegalTransitions(t *testing.T) {
	b := newBox(t, Lifecycle{OnTimeout: OnTimeoutPause})
	if _, err := b.Resume(); !errors.Is(err, ErrNotPaused) {
		t.Fatalf("Resume while running: %v", err)
	}
	if err := b.Pause(); err != nil {
		t.Fatal(err)
	}
	if err := b.Pause(); !errors.Is(err, ErrNotRunning) {
		t.Fatalf("Pause while paused: %v", err)
	}
	b.Kill()
	if b.State() != Killed {
		t.Fatalf("state %v", b.State())
	}
	if _, err := b.Resume(); !errors.Is(err, ErrNotPaused) {
		t.Fatalf("Resume after kill: %v", err)
	}
}

func TestFailedResumeThenFresh(t *testing.T) {
	b := newBox(t, Lifecycle{OnTimeout: OnTimeoutPause})
	write(t, filepath.Join(b.workdir, "a.txt"), "x")
	if err := b.Pause(); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(b.snapshot); err != nil {
		t.Fatal(err)
	}
	_, err := b.Resume()
	var re *ResumeError
	if !errors.As(err, &re) || !re.CanRetryFresh || b.State() != Paused {
		t.Fatalf("Resume err = %v, state %v", err, b.State())
	}
	if err := b.ResumeFresh(); err != nil || b.State() != Running {
		t.Fatalf("ResumeFresh: %v state %v", err, b.State())
	}
	if _, err := os.Stat(filepath.Join(b.workdir, "a.txt")); err == nil {
		t.Fatal("fresh start kept old state")
	}
}

func TestOnTimeoutAndAutoResume(t *testing.T) {
	t0 := time.Unix(0, 0)
	pol := Policy{IdleTimeout: time.Minute}
	for _, tc := range []struct {
		name string
		lc   Lifecycle
		want State
	}{
		{"kill", Lifecycle{}, Killed},
		{"pause", Lifecycle{OnTimeout: OnTimeoutPause}, Paused},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := newBox(t, tc.lc)
			if err := b.Tick(pol, t0.Add(time.Hour), t0, t0, 0); err != nil || b.State() != tc.want {
				t.Fatalf("Tick: %v state %v, want %v", err, b.State(), tc.want)
			}
		})
	}
	b := newBox(t, Lifecycle{OnTimeout: OnTimeoutPause, AutoResume: true})
	if err := b.Tick(pol, t0.Add(time.Hour), t0, t0, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := b.Ensure(); err != nil || b.State() != Running {
		t.Fatalf("Ensure with autoResume: %v state %v", err, b.State())
	}
	b = newBox(t, Lifecycle{OnTimeout: OnTimeoutPause})
	_ = b.Pause()
	if _, err := b.Ensure(); !errors.Is(err, ErrPaused) {
		t.Fatalf("Ensure without autoResume: %v", err)
	}
}
