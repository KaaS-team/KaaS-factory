package sandbox

import (
	"context"
	"errors"
	"io"
)

// BackendRemote selects the remote backend in Spec.Backend. It runs off the host, so it has no
// local command: use RunRemote with a Session, such as the one in pkg/sandbox/remote.
const BackendRemote = "remote"

// ErrRemoteBackend is returned by Command when Spec.Backend is "remote".
var ErrRemoteBackend = errors.New("sandbox: backend \"remote\" runs through RunRemote, not Command")

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
