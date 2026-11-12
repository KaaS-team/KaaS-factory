//go:build !unix

package local

import (
	"os"
	"os/exec"
)

func ownGroup(*exec.Cmd) {}

// killGroup kills only the child where process groups are not available.
func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}

// interruptGroup interrupts only the child where process groups are not available.
func interruptGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Signal(os.Interrupt)
}
