//go:build unix

package local

import (
	"os/exec"
	"syscall"
)

// ownGroup puts the child in its own process group so a kill reaches its descendants.
func ownGroup(cmd *exec.Cmd) { cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true} }

// killGroup kills the child's whole process group. A group that is already gone is not an error.
func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	if err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL); err != nil && err != syscall.ESRCH {
		return err
	}
	return nil
}

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
