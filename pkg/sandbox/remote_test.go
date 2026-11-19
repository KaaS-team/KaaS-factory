package sandbox

import (
	"context"
	"errors"
	"io"
	"testing"
)

type spy struct{ destroyed []string }

func (s *spy) Exec(context.Context, string, []string, io.Writer, io.Writer) error { return nil }
func (s *spy) CopyIn(context.Context, string, string, io.Reader) error            { return nil }
func (s *spy) CopyOut(context.Context, string, string, io.Writer) error           { return nil }
func (s *spy) Destroy(_ context.Context, id string) error {
	s.destroyed = append(s.destroyed, id)
	return nil
}

func TestRunRemoteDestroysOnFailure(t *testing.T) {
	s := &spy{}
	boom := errors.New("boom")
	err := RunRemote(t.Context(), func(context.Context) (string, error) { return "b1", nil }, s, func(string) error { return boom })
	if !errors.Is(err, boom) || len(s.destroyed) != 1 || s.destroyed[0] != "b1" {
		t.Fatalf("err=%v destroyed=%v", err, s.destroyed)
	}
}

func TestRunRemoteCreateFailureDestroysNothing(t *testing.T) {
	s := &spy{}
	err := RunRemote(t.Context(), func(context.Context) (string, error) { return "", errors.New("no") }, s, func(string) error { return nil })
	if err == nil || len(s.destroyed) != 0 {
		t.Fatalf("err=%v destroyed=%v", err, s.destroyed)
	}
}

func TestCommandRejectsRemote(t *testing.T) {
	if _, err := Command(t.Context(), Spec{Backend: BackendRemote, Workdir: t.TempDir()}, "echo"); !errors.Is(err, ErrRemoteBackend) {
		t.Fatalf("got %v", err)
	}
}
