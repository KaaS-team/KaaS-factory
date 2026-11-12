package eval

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
	"github.com/KaaS-team/factory/internal/dispatch/local"
)

// LocalConfig says where the fixtures are and how the agent is started.
type LocalConfig struct {
	Fixtures string // directory of fixtures, as LoadMatrix reads it
	Agent    string // preset name
	Workflow string
	Binary   string // replaces the preset's argv[0]; tests pass a fake agent
	Work     string // directory the per-fixture repos are built in
}

// localDeps runs each ticket through the local dispatcher in a copy of the fixture seed.
type localDeps struct {
	ctx      context.Context
	cfg      LocalConfig
	fixtures map[string]Fixture
}

// NewLocalDeps returns Deps that dispatch every ticket through the local dispatcher
// (Symphony §10.1). One repo per fixture lives under cfg.Work, so a later ticket of a
// fixture builds on the earlier ones. Cancelling ctx kills the running agent.
func NewLocalDeps(ctx context.Context, cfg LocalConfig) (Deps, error) {
	if cfg.Work == "" {
		return nil, errors.New("eval: a work directory is required")
	}
	m, err := LoadMatrix(cfg.Fixtures)
	if err != nil {
		return nil, err
	}
	l := &localDeps{ctx: ctx, cfg: cfg, fixtures: map[string]Fixture{}}
	for _, f := range m.Fixtures {
		l.fixtures[f.Name] = f
	}
	return l, nil
}

// Add is local.Worktrees: the fixture's repo, seeded on first use. A ticket's Repo is its fixture name.
func (l *localDeps) Add(_ context.Context, b api.Brief) (string, error) {
	f, ok := l.fixtures[b.Repo]
	if !ok {
		return "", fmt.Errorf("eval: no fixture named %q", b.Repo)
	}
	dir := filepath.Join(l.cfg.Work, f.Name)
	if _, err := os.Stat(dir); err == nil {
		return dir, nil
	}
	return dir, copyTree(filepath.Join(l.cfg.Fixtures, f.Name, f.Seed), dir)
}

func (l *localDeps) Dispatch(ctx context.Context, t api.Ticket) (Outcome, error) {
	name, err := brief.Name(t.ID, 1)
	if err != nil {
		return Outcome{}, err
	}
	// One dispatcher per ticket: its session key is (ticket, attempt), and ids repeat across fixtures.
	d, err := local.New(l.ctx, local.Config{Worktrees: l, Binary: l.cfg.Binary})
	if err != nil {
		return Outcome{}, err
	}
	s, err := d.Dispatch(ctx, api.Brief{
		Ticket: t.ID, Attempt: 1, Name: name, Text: t.Title + "\n\n" + t.Body, Repo: t.Repo, Base: "main",
		Branch: fmt.Sprintf("factory/%s-a1", t.ID), Agent: l.cfg.Agent, Workflow: l.cfg.Workflow,
	})
	if err != nil {
		return Outcome{}, err
	}
	// A crashed agent is a ticket that fails the hidden tests, not an eval error; only a stopped context is.
	if err := d.Wait(ctx, s); ctx.Err() != nil {
		return Outcome{}, err
	}
	u, err := d.Usage(ctx, s)
	return Outcome{Attempts: 1, Updates: []api.Usage{u}, Wall: u.WallTime}, err
}

func (l *localDeps) Gate(ctx context.Context, t api.Ticket) (bool, error) {
	f := l.fixtures[t.Repo]
	return l.sh(ctx, f.Name, f.Gate)
}

func (l *localDeps) HiddenTest(ctx context.Context, t api.Ticket, command string) (bool, error) {
	f := l.fixtures[t.Repo]
	dir := filepath.Join(l.cfg.Work, f.Name)
	if err := copyTree(filepath.Join(l.cfg.Fixtures, f.Name, "hidden", string(t.ID)), dir); err != nil {
		return false, err
	}
	return l.sh(ctx, f.Name, command)
}

// sh runs command in the fixture's repo. A failing exit is false, not an error.
func (l *localDeps) sh(ctx context.Context, fixture, command string) (bool, error) {
	if command == "" {
		return true, nil
	}
	cmd := exec.CommandContext(ctx, "sh", "-c", command)
	cmd.Dir = filepath.Join(l.cfg.Work, fixture)
	err := cmd.Run()
	var exit *exec.ExitError
	if errors.As(err, &exit) {
		return false, nil
	}
	return err == nil, err
}

// copyTree copies the files under src into dst, over what is there.
func copyTree(src, dst string) error {
	return filepath.WalkDir(src, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		to := filepath.Join(dst, rel)
		if e.IsDir() {
			return os.MkdirAll(to, 0o755)
		}
		b, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		return os.WriteFile(to, b, 0o644)
	})
}
