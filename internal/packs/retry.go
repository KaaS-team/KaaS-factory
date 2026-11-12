// Ported from block/goose@910d084 crates/goose/src/agents/retry.rs
package packs

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"time"
)

// Defaults and caps from goose: 300 s per check, 600 s for on_failure, the last 8 KiB of stderr kept.
const (
	DefaultCheckTimeout     = 300 * time.Second
	DefaultOnFailureTimeout = 600 * time.Second
	StderrCap               = 8 * 1024
)

// ErrChecksFailed means a success check still failed after the last retry.
var ErrChecksFailed = errors.New("success checks failed")

// Check is one success check. Only the shell type exists: it passes when the command exits 0.
type Check struct {
	Type    string `yaml:"type"`
	Command string `yaml:"command"`
}

// Retry is the optional retry block of a manifest.
type Retry struct {
	MaxRetries              int     `yaml:"max_retries"`
	Checks                  []Check `yaml:"checks"`
	OnFailure               string  `yaml:"on_failure,omitempty"`
	TimeoutSeconds          *int    `yaml:"timeout_seconds,omitempty"`
	OnFailureTimeoutSeconds *int    `yaml:"on_failure_timeout_seconds,omitempty"`
}

// Validate checks max_retries, the timeouts and each check.
func (r Retry) Validate() error {
	if r.MaxRetries <= 0 {
		return errors.New("max_retries must be greater than 0")
	}
	if r.TimeoutSeconds != nil && *r.TimeoutSeconds <= 0 {
		return errors.New("timeout_seconds must be greater than 0 if specified")
	}
	if r.OnFailureTimeoutSeconds != nil && *r.OnFailureTimeoutSeconds <= 0 {
		return errors.New("on_failure_timeout_seconds must be greater than 0 if specified")
	}
	for i, c := range r.Checks {
		if c.Type != "shell" {
			return fmt.Errorf("checks[%d]: type must be shell, got %q", i, c.Type)
		}
		if c.Command == "" {
			return fmt.Errorf("checks[%d]: command is required", i)
		}
	}
	return nil
}

func (r Retry) timeout() time.Duration {
	if r.TimeoutSeconds != nil {
		return time.Duration(*r.TimeoutSeconds) * time.Second
	}
	return DefaultCheckTimeout
}

func (r Retry) onFailureTimeout() time.Duration {
	if r.OnFailureTimeoutSeconds != nil {
		return time.Duration(*r.OnFailureTimeoutSeconds) * time.Second
	}
	return DefaultOnFailureTimeout
}

// Run runs task, then the checks in dir. If a check fails it runs task again, up to MaxRetries more
// times. When the checks still fail it runs on_failure and returns ErrChecksFailed. A task error or a
// check that times out ends the run at once and is returned as is.
func (r Retry) Run(ctx context.Context, dir string, task func(context.Context) error) error {
	for attempt := 0; ; attempt++ {
		if err := task(ctx); err != nil {
			return err
		}
		ok, err := r.checksPass(ctx, dir)
		if err != nil {
			return err
		}
		if ok {
			return nil
		}
		if attempt >= r.MaxRetries {
			break
		}
	}
	if r.OnFailure != "" {
		if _, code, err := runShell(ctx, dir, r.OnFailure, r.onFailureTimeout()); err != nil {
			return fmt.Errorf("on_failure: %w", err)
		} else if code != 0 {
			return fmt.Errorf("on_failure exited %d: %w", code, ErrChecksFailed)
		}
	}
	return ErrChecksFailed
}

func (r Retry) checksPass(ctx context.Context, dir string) (bool, error) {
	for _, c := range r.Checks {
		_, code, err := runShell(ctx, dir, c.Command, r.timeout())
		if err != nil {
			return false, err
		}
		if code != 0 {
			return false, nil
		}
	}
	return true, nil
}

// runShell runs command with sh -c under a timeout and returns the last StderrCap bytes of stderr
// and the exit code. A timeout is an error, never a pass.
func runShell(ctx context.Context, dir, command string, timeout time.Duration) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = dir
	tail := &tailBuffer{max: StderrCap}
	cmd.Stderr = tail
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return tail.Bytes(), -1, fmt.Errorf("shell command timed out after %s: %s", timeout, command)
	}
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return tail.Bytes(), exit.ExitCode(), nil
	}
	if err != nil {
		return nil, -1, err
	}
	return tail.Bytes(), 0, nil
}

// tailBuffer keeps the last max bytes written to it.
type tailBuffer struct {
	max int
	buf bytes.Buffer
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if len(p) >= t.max {
		t.buf.Reset()
		p = p[len(p)-t.max:]
	} else if over := t.buf.Len() + len(p) - t.max; over > 0 {
		rest := append([]byte(nil), t.buf.Bytes()[over:]...)
		t.buf.Reset()
		t.buf.Write(rest)
	}
	t.buf.Write(p)
	return n, nil
}

func (t *tailBuffer) Bytes() []byte { return t.buf.Bytes() }
