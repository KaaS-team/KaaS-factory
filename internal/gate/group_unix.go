//go:build unix

package gate

import (
	"os/exec"
	"syscall"
)

// setGroup puts the command in its own process group and makes cancellation kill the whole group.
func setGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	}
}
