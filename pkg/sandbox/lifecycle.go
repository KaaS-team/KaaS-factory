package sandbox

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// OnTimeout says what happens to a session the Policy reclaims.
type OnTimeout string

// The OnTimeout values.
const (
	OnTimeoutKill  OnTimeout = "kill"
	OnTimeoutPause OnTimeout = "pause"
)

// PauseMode says what a pause keeps. Only the workdir is kept; no memory or process state.
type PauseMode string

// PauseFilesystem keeps the workdir and cold-starts on resume.
const PauseFilesystem PauseMode = "filesystem"

// Lifecycle is the lifecycle contract of one session.
type Lifecycle struct {
	// OnTimeout is kill (default) or pause.
	OnTimeout OnTimeout
	// PauseMode is filesystem, the only mode; empty means filesystem when OnTimeout is pause.
	PauseMode PauseMode
	// AutoResume lets Ensure resume a paused session instead of failing.
	AutoResume bool
}

// State is where a Box is in its lifecycle.
type State int

// The states of a Box.
const (
	Running State = iota
	Paused
	Killed
)

// Errors for the lifecycle transitions.
var (
	ErrNotRunning = errors.New("sandbox: session is not running")
	ErrNotPaused  = errors.New("sandbox: session is not paused")
	ErrPaused     = errors.New("sandbox: session is paused and autoResume is off")
)

// ResumeError is a failed resume. CanRetryFresh says Box.ResumeFresh will start without the saved state.
type ResumeError struct {
	Cause         error
	CanRetryFresh bool
}

func (e *ResumeError) Error() string { return "sandbox: resume failed: " + e.Cause.Error() }

// Unwrap returns the cause.
func (e *ResumeError) Unwrap() error { return e.Cause }

// Resumed reports how a resume came back.
type Resumed struct {
	// PauseMode is the mode the session was paused with.
	PauseMode PauseMode
}

// Box is one session's lifecycle: it pauses by copying the workdir aside and resumes by copying it back.
type Box struct {
	lc       Lifecycle
	workdir  string
	snapshot string
	state    State
}

// NewBox validates lc and returns a running Box over workdir, saving pauses in snapshot.
func NewBox(lc Lifecycle, workdir, snapshot string) (*Box, error) {
	switch lc.OnTimeout {
	case "":
		lc.OnTimeout = OnTimeoutKill
	case OnTimeoutKill, OnTimeoutPause:
	default:
		return nil, fmt.Errorf("sandbox: unknown onTimeout %q", lc.OnTimeout)
	}
	if lc.OnTimeout == OnTimeoutPause && lc.PauseMode == "" {
		lc.PauseMode = PauseFilesystem
	}
	if lc.PauseMode != "" && lc.PauseMode != PauseFilesystem {
		return nil, fmt.Errorf("sandbox: unknown pauseMode %q", lc.PauseMode)
	}
	if lc.AutoResume && lc.OnTimeout != OnTimeoutPause {
		return nil, errors.New("sandbox: autoResume needs onTimeout pause")
	}
	return &Box{lc: lc, workdir: workdir, snapshot: snapshot}, nil
}

// State returns the current state.
func (b *Box) State() State { return b.state }

// Pause saves the workdir and moves a running session to Paused.
func (b *Box) Pause() error {
	if b.state != Running {
		return ErrNotRunning
	}
	if err := os.RemoveAll(b.snapshot); err != nil {
		return fmt.Errorf("sandbox: pause: %w", err)
	}
	if err := os.CopyFS(b.snapshot, os.DirFS(b.workdir)); err != nil {
		return fmt.Errorf("sandbox: pause: %w", err)
	}
	b.state = Paused
	return nil
}

// Resume cold-starts a paused session from its saved workdir. On failure the
// session stays Paused and the error says whether ResumeFresh can follow.
func (b *Box) Resume() (Resumed, error) {
	if b.state != Paused {
		return Resumed{}, ErrNotPaused
	}
	if err := os.RemoveAll(b.workdir); err != nil {
		return Resumed{}, &ResumeError{Cause: err, CanRetryFresh: true}
	}
	if err := os.CopyFS(b.workdir, os.DirFS(b.snapshot)); err != nil {
		return Resumed{}, &ResumeError{Cause: err, CanRetryFresh: true}
	}
	b.state = Running
	return Resumed{PauseMode: b.lc.PauseMode}, nil
}

// ResumeFresh starts a paused session with an empty workdir and drops the saved state.
func (b *Box) ResumeFresh() error {
	if b.state != Paused {
		return ErrNotPaused
	}
	if err := os.RemoveAll(b.workdir); err != nil {
		return fmt.Errorf("sandbox: fresh resume: %w", err)
	}
	if err := os.MkdirAll(b.workdir, 0o755); err != nil {
		return fmt.Errorf("sandbox: fresh resume: %w", err)
	}
	_ = os.RemoveAll(b.snapshot)
	b.state = Running
	return nil
}

// Kill ends the session for good.
func (b *Box) Kill() { b.state = Killed }

// Ensure returns a running session: it resumes a paused one when AutoResume is on and fails with ErrPaused otherwise.
func (b *Box) Ensure() (Resumed, error) {
	switch {
	case b.state == Paused && b.lc.AutoResume:
		return b.Resume()
	case b.state == Paused:
		return Resumed{}, ErrPaused
	case b.state == Killed:
		return Resumed{}, ErrNotRunning
	}
	return Resumed{PauseMode: b.lc.PauseMode}, nil
}

// Tick applies pol to a running session: a max-duration breach always kills,
// an idle reclaim kills or pauses as OnTimeout says.
func (b *Box) Tick(pol Policy, now, start, lastActivity time.Time, foreground int) error {
	if b.state != Running {
		return nil
	}
	switch pol.Decide(now, start, lastActivity, foreground) {
	case KillMaxDuration:
		b.Kill()
	case ReclaimIdle:
		if b.lc.OnTimeout == OnTimeoutPause {
			return b.Pause()
		}
		b.Kill()
	}
	return nil
}
