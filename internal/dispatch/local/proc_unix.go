//go:build unix

package local

import (
	"os/exec"
	"syscall"
)

// interruptGroup sends SIGINT to the child's whole process group.
func interruptGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGINT); err != nil && err != syscall.ESRCH {
		return err
	}
	return nil
}
