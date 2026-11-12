package packs

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRetryValidate(t *testing.T) {
	zero := 0
	one := 1
	tests := []struct {
		name string
		r    Retry
		want string
	}{
		{"ok", Retry{MaxRetries: 1}, ""},
		{"zero retries", Retry{}, "max_retries"},
		{"zero timeout", Retry{MaxRetries: 1, TimeoutSeconds: &zero}, "timeout_seconds"},
		{"zero on_failure timeout", Retry{MaxRetries: 1, OnFailureTimeoutSeconds: &zero}, "on_failure_timeout_seconds"},
		{"set timeouts", Retry{MaxRetries: 1, TimeoutSeconds: &one, OnFailureTimeoutSeconds: &one}, ""},
		{"check without command", Retry{MaxRetries: 1, Checks: []Check{{Type: "shell"}}}, "command"},
		{"unknown check type", Retry{MaxRetries: 1, Checks: []Check{{Type: "http", Command: "x"}}}, "type"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.r.Validate()
			if tc.want == "" && err != nil || tc.want != "" && (err == nil || !strings.Contains(err.Error(), tc.want)) {
				t.Fatalf("err = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestRetryDefaultTimeouts(t *testing.T) {
	if got := (Retry{}).timeout(); got != 300*time.Second {
		t.Fatalf("check timeout = %v", got)
	}
	if got := (Retry{}).onFailureTimeout(); got != 600*time.Second {
		t.Fatalf("on_failure timeout = %v", got)
	}
}

// counter returns a task that counts its runs, and a check command that passes once the count reaches n.
func counter(t *testing.T, passAt int) (task func(context.Context) error, runs *int, check string) {
	t.Helper()
	dir := t.TempDir()
	file := filepath.Join(dir, "n")
	n := 0
	task = func(context.Context) error {
		n++
		return os.WriteFile(file, []byte{byte(n)}, 0o644)
	}
	return task, &n, "test \"$(od -An -tu1 " + file + " | tr -d ' ')\" -ge " + string(rune('0'+passAt))
}

func TestRetryRun(t *testing.T) {
	t.Run("a passing check ends it after one run", func(t *testing.T) {
		task, runs, check := counter(t, 1)
		r := Retry{MaxRetries: 3, Checks: []Check{{Type: "shell", Command: check}}}
		if err := r.Run(context.Background(), "", task); err != nil || *runs != 1 {
			t.Fatalf("err=%v runs=%d", err, *runs)
		}
	})
	t.Run("a failing check re-runs until it passes", func(t *testing.T) {
		task, runs, check := counter(t, 3)
		r := Retry{MaxRetries: 3, Checks: []Check{{Type: "shell", Command: check}}}
		if err := r.Run(context.Background(), "", task); err != nil || *runs != 3 {
			t.Fatalf("err=%v runs=%d", err, *runs)
		}
	})
	t.Run("a failing check stops at max_retries and runs on_failure", func(t *testing.T) {
		task, runs, _ := counter(t, 1)
		marker := filepath.Join(t.TempDir(), "cleaned")
		r := Retry{MaxRetries: 2, Checks: []Check{{Type: "shell", Command: "false"}}, OnFailure: "touch " + marker}
		err := r.Run(context.Background(), "", task)
		if !errors.Is(err, ErrChecksFailed) || *runs != 3 {
			t.Fatalf("err=%v runs=%d, want ErrChecksFailed after 1 run + 2 retries", err, *runs)
		}
		if _, err := os.Stat(marker); err != nil {
			t.Fatalf("on_failure did not run: %v", err)
		}
	})
	t.Run("a task error is returned and is not retried", func(t *testing.T) {
		boom := errors.New("boom")
		n := 0
		r := Retry{MaxRetries: 3, Checks: []Check{{Type: "shell", Command: "true"}}}
		err := r.Run(context.Background(), "", func(context.Context) error { n++; return boom })
		if !errors.Is(err, boom) || n != 1 {
			t.Fatalf("err=%v n=%d", err, n)
		}
	})
	t.Run("a timed out check is an error, not a pass", func(t *testing.T) {
		one := 1
		n := 0
		r := Retry{MaxRetries: 1, TimeoutSeconds: &one, Checks: []Check{{Type: "shell", Command: "sleep 5"}}}
		start := time.Now()
		err := r.Run(context.Background(), "", func(context.Context) error { n++; return nil })
		if err == nil || !strings.Contains(err.Error(), "timed out") || errors.Is(err, ErrChecksFailed) {
			t.Fatalf("err = %v", err)
		}
		if n != 1 || time.Since(start) > 4*time.Second {
			t.Fatalf("n=%d elapsed=%v", n, time.Since(start))
		}
	})
}

func TestRunShellCapsStderrAtTail8KiB(t *testing.T) {
	out, code, err := runShell(context.Background(), "", `head -c 20000 /dev/zero | tr '\0' a >&2; printf END >&2; exit 3`, time.Minute)
	if err != nil || code != 3 {
		t.Fatalf("code=%d err=%v", code, err)
	}
	if len(out) != StderrCap || !strings.HasSuffix(string(out), "END") {
		t.Fatalf("len=%d, want the last %d bytes ending in END", len(out), StderrCap)
	}
}
