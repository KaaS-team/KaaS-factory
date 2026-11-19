package sandbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"time"

	"github.com/KaaS-team/factory/pkg/sandbox/remote"
)

// BackendRemote selects the remote backend in Spec.Backend. It runs off the host, so it has no
// local command: use RunRemote with a Session, such as the one in pkg/sandbox/remote.
const BackendRemote = "remote"

// ErrRemoteBackend is returned by Command when Spec.Backend is "remote" and the remote service is
// not configured (FACTORY_SANDBOX_URL and FACTORY_SANDBOX_TOKEN).
var ErrRemoteBackend = errors.New("sandbox: backend \"remote\" needs a remote sandbox service")

// remoteCommand is the selector's remote row. The command is this binary as a helper, like the jail
// row, so callers still get an *exec.Cmd with stdout and stderr. MaybeEnter then runs argv in a box on
// the remote service and exits with its status. The service URL and token travel in the helper's
// environment only.
func remoteCommand(ctx context.Context, spec Spec, name string, args ...string) (*exec.Cmd, error) {
	if _, err := remote.FromEnv(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrRemoteBackend, err)
	}
	self, err := os.Executable()
	if err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	payload, err := json.Marshal(request{Spec: spec, Argv: append([]string{name}, args...)})
	if err != nil {
		return nil, fmt.Errorf("sandbox: %w", err)
	}
	cmd := exec.CommandContext(ctx, self)
	OwnGroup(cmd)
	cmd.Cancel = func() error { return KillGroup(cmd) }
	cmd.WaitDelay = 2 * time.Second
	cmd.Env = []string{helperEnv + "=" + string(payload), remote.EnvURL + "=" + os.Getenv(remote.EnvURL), remote.EnvToken + "=" + os.Getenv(remote.EnvToken)}
	return cmd, nil
}

// runRemoteHelper is the helper side: run req.Argv in a new box and exit with its status.
func runRemoteHelper(req request) error {
	c, err := remote.FromEnv()
	if err != nil {
		return err
	}
	ctx := context.Background()
	create := func(ctx context.Context) (string, error) {
		return c.Create(ctx, remote.CreateSpec{Workdir: req.Spec.Workdir, Env: req.Spec.Env, AllowNet: req.Spec.AllowNet})
	}
	err = RunRemote(ctx, create, c, func(id string) error { return c.Exec(ctx, id, req.Argv, os.Stdout, os.Stderr) })
	var ee *remote.ExitError
	if errors.As(err, &ee) {
		os.Exit(ee.Code)
	}
	if err != nil {
		return err
	}
	os.Exit(0)
	return nil
}

// Session is a box on a remote sandbox service. The remote package's Client implements it with
// its own create spec; wrap it with a small adapter or use RunRemote with a closure.
type Session interface {
	Exec(ctx context.Context, id string, argv []string, stdout, stderr io.Writer) error
	CopyIn(ctx context.Context, id, path string, r io.Reader) error
	CopyOut(ctx context.Context, id, path string, w io.Writer) error
	Destroy(ctx context.Context, id string) error
}

// RunRemote runs fn against a box that create made. It always destroys the box afterwards, even
// when fn fails or ctx is cancelled, and joins a destroy error to fn's error.
func RunRemote(ctx context.Context, create func(context.Context) (string, error), s Session, fn func(id string) error) (err error) {
	id, err := create(ctx)
	if err != nil {
		return err
	}
	defer func() {
		// A cancelled ctx must not stop the cleanup.
		err = errors.Join(err, s.Destroy(context.WithoutCancel(ctx), id))
	}()
	return fn(id)
}
