//go:build linux

package sandbox

import (
	"context"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// Symphony section 8 (timeouts): a timeout kills the whole process group, not only the child.
func TestTimeoutKillsGrandchild(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	spec := Spec{Workdir: t.TempDir(), ReadOnly: []string{"/"}, AllowNet: true}
	cmd, err := Command(ctx, spec, "sh", "-c", "sleep 60 & echo $!; wait")
	if err != nil {
		t.Fatal(err)
	}
	out, _ := cmd.Output()
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		t.Fatalf("no grandchild pid in %q", out)
	}
	deadline := time.Now().Add(3 * time.Second)
	for syscall.Kill(pid, 0) == nil && !zombie(pid) {
		if time.Now().After(deadline) {
			_ = syscall.Kill(pid, syscall.SIGKILL)
			t.Fatalf("grandchild %d survived the timeout", pid)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// zombie reports whether pid is dead but not yet reaped by its parent.
func zombie(pid int) bool {
	b, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	return err != nil || strings.Contains(string(b), ") Z ")
}
