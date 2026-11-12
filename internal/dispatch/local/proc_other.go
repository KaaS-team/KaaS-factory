//go:build !unix

package local

import (
	"os"
	"os/exec"
)

// interruptGroup interrupts only the child where process groups are not available.
func interruptGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Signal(os.Interrupt)
}
