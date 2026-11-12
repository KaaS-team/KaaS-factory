//go:build !unix

package sandbox

import "os/exec"

// OwnGroup does nothing where process groups are not available.
func OwnGroup(*exec.Cmd) {}

// KillGroup kills only the child where process groups are not available.
func KillGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
