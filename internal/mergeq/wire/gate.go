package wire

import (
	"context"
	"fmt"
	"os"
	"time"

	"github.com/KaaS-team/factory/internal/gate"
	"github.com/KaaS-team/factory/internal/gitx"
	"github.com/KaaS-team/factory/internal/mergeq"
)

// DefaultGateCommand runs the repo's .factory/gates.sh, or gates.sh from PATH when the repo has none.
const DefaultGateCommand = `if [ -x .factory/gates.sh ]; then .factory/gates.sh; else gates.sh; fi`

// DefaultGateTimeout bounds one gate run.
const DefaultGateTimeout = 30 * time.Minute

// Gate is mergeq.Gate over internal/gate: it checks the ref out into a throwaway worktree of the
// clone and runs the gate command there.
type Gate struct {
	G       gitx.Git
	Command string        // DefaultGateCommand when empty
	Timeout time.Duration // DefaultGateTimeout when zero
}

var _ mergeq.Gate = Gate{}

// Run grades ref. Only a GREEN FACTORY_GATES line passes; the verdict's log is the gate output tail.
func (g Gate) Run(ctx context.Context, ref string) (mergeq.Verdict, error) {
	dir, err := os.MkdirTemp("", "factory-gate-")
	if err != nil {
		return mergeq.Verdict{}, fmt.Errorf("gate worktree: %w", err)
	}
	defer func() { _ = os.RemoveAll(dir) }()
	wt := Git{G: g.G}
	if _, err := wt.must(ctx, "worktree", "add", "-q", "--detach", dir, ref); err != nil {
		return mergeq.Verdict{}, err
	}
	defer func() { _, _ = wt.must(context.WithoutCancel(ctx), "worktree", "remove", "--force", dir) }()
	cmd, timeout := g.Command, g.Timeout
	if cmd == "" {
		cmd = DefaultGateCommand
	}
	if timeout == 0 {
		timeout = DefaultGateTimeout
	}
	res := gate.Run(ctx, gate.Spec{Command: cmd, Dir: dir, Timeout: timeout})
	return mergeq.Verdict{Pass: res.Green(), LogTail: res.Tail}, nil
}
