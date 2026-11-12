//go:build !unix

package local

import "os/exec"

func ownGroup(*exec.Cmd) {}

// killGroup kills only the child where process groups are not available.
func killGroup(cmd *exec.Cmd) error {
	if cmd.Process == nil {
		return nil
	}
	return cmd.Process.Kill()
}
