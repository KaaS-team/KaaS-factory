package astgrep

import (
	"bytes"
	"context"
	"errors"
	"os/exec"

	"github.com/KaaS-team/factory/pkg/sandbox"
)

// JailRunner runs the ast-grep binary at Bin under the sandbox with no network.
type JailRunner struct{ Bin string }

// Run runs Bin with args in dir under JailSpec and returns its output and exit code.
func (j JailRunner) Run(ctx context.Context, dir string, args []string) (Result, error) {
	cmd, err := sandbox.Command(ctx, JailSpec(dir, j.Bin), j.Bin, args...)
	if err != nil {
		return Result{}, err
	}
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	err = cmd.Run()
	var ee *exec.ExitError
	if err != nil && !errors.As(err, &ee) {
		return Result{}, err
	}
	res := Result{Stdout: out.Bytes(), Stderr: errb.Bytes()}
	if ee != nil {
		res.Exit = ee.ExitCode()
	}
	return res, nil
}
