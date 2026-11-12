// Package local is an api.Dispatcher that runs an agent CLI as a child
// process in a git worktree, from an argv preset.
package local

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
	"github.com/KaaS-team/factory/internal/dispatch/local/input"
	"github.com/KaaS-team/factory/internal/dispatch/local/stuck"
	"github.com/KaaS-team/factory/internal/dispatch/untrusted"
	"github.com/KaaS-team/factory/pkg/sandbox"
	"github.com/jonboulle/clockwork"
)

const defaultBudgetUSD = 5.0

// ErrUnsupported is returned for what a local run cannot do.
var ErrUnsupported = errors.New("local: not supported by a local run")

// ErrStuck is what Wait returns for a run the loop guard aborted; the message names the pattern.
var ErrStuck = errors.New("local: run is stuck in a loop")

// Run is what a preset turns into an argv.
type Run struct {
	Brief  api.Brief
	Prompt string
	Stage  string
	Budget float64
}

// Preset builds the argv and the extra environment for one agent CLI.
type Preset struct {
	Argv func(Run) ([]string, error)
	Env  map[string]string
	// Steer gives the agent a stdin that Steer writes to once its output has settled.
	Steer bool
}

// ClaudePreset is the `claude -p` preset. Its argv equals the TypeScript preset's.
var ClaudePreset = Preset{
	Argv: func(r Run) ([]string, error) {
		return ClaudeArgv(ClaudeInput{Stage: r.Stage, Issue: string(r.Brief.Ticket), MaxBudgetUSD: r.Budget, Prompt: r.Prompt, Model: r.Brief.Model})
	},
	// A headless run has no one to resume a background task for, and no reason to phone home.
	Env: map[string]string{"CLAUDE_CODE_DISABLE_BACKGROUND_TASKS": "1", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"},
}

// Config holds what the caller injects.
type Config struct {
	Worktrees     Worktrees
	Presets       map[string]Preset // default: {"claude": ClaudePreset}
	Binary        string            // replaces argv[0] of the preset, for tests and wrappers
	Environ       []string          // the parent environment; default os.Environ()
	Stage         string            // default "build"
	MaxConcurrent int
	Now           func() time.Time
	// Sandbox runs each agent under pkg/sandbox: reads anywhere, writes only in its worktree,
	// Writable and the agent's own state under the home directory.
	Sandbox  bool
	Writable []string
	// CloseTimeout is how long Cancel waits after SIGINT before it kills; default 5 seconds.
	CloseTimeout time.Duration
	// Clock times the steer gate and the close wait; default the real clock.
	Clock clockwork.Clock
	// Untrusted returns the tools to deny for a brief whose pull request author lacks write
	// access, or nil. A non-nil result is added to the argv's --disallowedTools, the Bash rules the
	// settings allow are cut to the untrusted allowlist (the run must be in dontAsk mode, or
	// Dispatch fails), and the files the agent CLI and git trust are restored while it runs and
	// when it ends.
	Untrusted func(context.Context, api.Brief) []string
}

type usageState struct {
	mu sync.Mutex
	u  api.Usage
}

type process struct {
	cmd    *exec.Cmd
	cancel context.CancelFunc
	done   chan struct{}
	err    error // set before done closes
	start  time.Time
	usage  usageState
	end    time.Time
	q      *input.Queue // nil unless the preset steers
}

// Dispatcher implements api.Dispatcher over child processes.
type Dispatcher struct {
	ctx context.Context
	cfg Config

	mu   sync.Mutex
	runs map[string]*process
}

// New returns a Dispatcher. Cancelling ctx kills every run it started.
func New(ctx context.Context, cfg Config) (*Dispatcher, error) {
	if cfg.Worktrees == nil {
		return nil, errors.New("local: worktrees are required")
	}
	if cfg.Presets == nil {
		cfg.Presets = map[string]Preset{"claude": ClaudePreset}
	}
	if cfg.Environ == nil {
		cfg.Environ = os.Environ()
	}
	if cfg.Stage == "" {
		cfg.Stage = "build"
	}
	if cfg.MaxConcurrent <= 0 {
		cfg.MaxConcurrent = 4
	}
	if cfg.CloseTimeout <= 0 {
		cfg.CloseTimeout = 5 * time.Second
	}
	if cfg.Clock == nil {
		cfg.Clock = clockwork.NewRealClock()
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	return &Dispatcher{ctx: ctx, cfg: cfg, runs: map[string]*process{}}, nil
}

// Name returns "local".
func (d *Dispatcher) Name() string { return "local" }

// Caps reports a local dispatcher: not remote, and it can push workflow files.
func (d *Dispatcher) Caps() api.Caps {
	return api.Caps{MaxConcurrent: d.cfg.MaxConcurrent, CanPushWorkflows: true}
}

var providerPrefixes = []string{"ANTHROPIC_", "OPENAI_", "AZURE_OPENAI_", "GEMINI_", "MISTRAL_", "COHERE_"}

func providerVar(name string) bool {
	up := strings.ToUpper(name)
	if up == "GOOGLE_API_KEY" || up == "CURSOR_API_KEY" {
		return true
	}
	for _, p := range providerPrefixes {
		if strings.HasPrefix(up, p) {
			return true
		}
	}
	return false
}

// childEnv is parent without provider keys, plus extra. Sessions run under
// the operator's login, so no key is ever passed on.
func childEnv(parent []string, extra map[string]string) []string {
	var out []string
	for _, kv := range parent {
		name, _, _ := strings.Cut(kv, "=")
		if _, over := extra[name]; over || providerVar(name) {
			continue
		}
		out = append(out, kv)
	}
	keys := make([]string, 0, len(extra))
	for k := range extra {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		out = append(out, k+"="+extra[k])
	}
	return out
}

// Dispatch starts the agent in a worktree and returns at once. A key this
// process already started returns the same session and starts nothing.
func (d *Dispatcher) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	name, err := brief.Name(b.Ticket, b.Attempt)
	if err != nil {
		return api.Session{}, err
	}
	if b.Name != name {
		return api.Session{}, fmt.Errorf("local: brief is named %q, want %q", b.Name, name)
	}
	agent := b.Agent
	if agent == "" {
		agent = "claude"
	}
	preset, ok := d.cfg.Presets[agent]
	if !ok {
		return api.Session{}, fmt.Errorf("local: no preset named %q", agent)
	}
	key := fmt.Sprintf("factory-%s-a%d", b.Ticket, b.Attempt)
	session := func(p *process) api.Session {
		return api.Session{Key: key, ID: key, Ticket: b.Ticket, Attempt: b.Attempt, Dispatcher: d.Name(), StartedAt: p.start}
	}

	d.mu.Lock()
	defer d.mu.Unlock()
	if p, ok := d.runs[key]; ok {
		return session(p), nil
	}
	budget := b.Budget.USD
	if budget <= 0 {
		budget = defaultBudgetUSD
	}
	argv, err := preset.Argv(Run{Brief: b, Prompt: brief.Prompt(b.Name), Stage: d.cfg.Stage, Budget: budget})
	if err != nil {
		return api.Session{}, err
	}
	if d.cfg.Binary != "" {
		argv[0] = d.cfg.Binary
	}
	dir, err := d.cfg.Worktrees.Add(ctx, b)
	if err != nil {
		return api.Session{}, err
	}
	var guard *untrusted.Guard
	if d.cfg.Untrusted != nil {
		if deny := d.cfg.Untrusted(ctx, b); len(deny) > 0 {
			if argv, err = untrusted.Restrict(argv, deny); err != nil {
				return api.Session{}, err
			}
			if guard, err = untrusted.Snapshot(dir); err != nil {
				return api.Session{}, err
			}
		}
	}

	runCtx, cancel := context.WithCancel(d.ctx)
	cmd, err := d.command(runCtx, argv, dir, childEnv(d.cfg.Environ, preset.Env))
	if err != nil {
		cancel()
		return api.Session{}, err
	}
	ownGroup(cmd)
	cmd.Cancel = func() error { return killGroup(cmd) }
	cmd.WaitDelay = 2 * time.Second
	out, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return api.Session{}, err
	}
	var q *input.Queue
	if preset.Steer {
		in, err := cmd.StdinPipe()
		if err != nil {
			cancel()
			return api.Session{}, err
		}
		tail := &input.Tail{Max: 8 << 10}
		out = io.NopCloser(io.TeeReader(out, tail))
		q = &input.Queue{Out: in, Snapshot: tail.String, Window: 3, Every: time.Second, Clock: d.cfg.Clock}
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return api.Session{}, fmt.Errorf("local: start %s: %w", argv[0], err)
	}
	p := &process{cmd: cmd, cancel: cancel, done: make(chan struct{}), start: d.cfg.Now(), q: q}
	d.runs[key] = p
	go func() { // ends when the process exits; the run context kills it
		sc := bufio.NewScanner(out)
		sc.Buffer(make([]byte, 0, 64<<10), 8<<20)
		loop := stuck.New(stuck.DefaultThresholds)
		var stuckErr, restoreErr error
		var lastRestore time.Time
		restore := func() {
			if _, rerr := guard.Restore(); rerr != nil && restoreErr == nil {
				restoreErr = rerr
			}
		}
		for sc.Scan() {
			p.usage.feed(sc.Bytes())
			// The agent CLI re-reads its settings while it runs, so put them back at most once a second.
			if guard != nil && d.cfg.Clock.Since(lastRestore) >= time.Second {
				lastRestore = d.cfg.Clock.Now()
				restore()
			}
			if stuckErr != nil {
				continue // drain until the kill lands
			}
			switch v := loop.Feed(sc.Bytes()); v.Kind {
			case stuck.Nudge:
				_ = d.Steer(runCtx, session(p), v.Message) // unsupported today, so the nudge is not delivered
			case stuck.Abort:
				stuckErr = fmt.Errorf("%w: %s (%s)", ErrStuck, v.Pattern, v.Message)
				cancel()
			}
		}
		p.err = cmd.Wait()
		if stuckErr != nil {
			p.err = stuckErr
		}
		_ = killGroup(cmd) // anything the agent left behind
		if guard != nil {
			restore()
			if restoreErr != nil && p.err == nil {
				p.err = fmt.Errorf("local: restore after untrusted session: %w", restoreErr)
			}
		}
		p.end = d.cfg.Now()
		cancel()
		close(p.done)
	}()
	return session(p), nil
}

// command builds the agent process. With Sandbox set it is the jail helper, which applies the
// restrictions and then execs argv with env as its whole environment.
func (d *Dispatcher) command(ctx context.Context, argv []string, dir string, env []string) (*exec.Cmd, error) {
	if !d.cfg.Sandbox {
		cmd := exec.CommandContext(ctx, argv[0], argv[1:]...)
		cmd.Dir, cmd.Env = dir, env
		return cmd, nil
	}
	rw := append([]string{os.TempDir()}, d.cfg.Writable...)
	if home, err := os.UserHomeDir(); err == nil {
		rw = append(rw, filepath.Join(home, ".claude"), filepath.Join(home, ".claude.json"))
	}
	return sandbox.Command(ctx, sandbox.Spec{Workdir: dir, ReadOnly: []string{"/"}, ReadWrite: rw, AllowNet: true, Env: env}, argv[0], argv[1:]...)
}

// Wait blocks until the session's process has exited. It returns the exit
// error, or ctx's error if ctx ends first.
func (d *Dispatcher) Wait(ctx context.Context, s api.Session) error {
	p, err := d.run(s)
	if err != nil {
		return err
	}
	select {
	case <-p.done:
		return p.err
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (d *Dispatcher) run(s api.Session) (*process, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, ok := d.runs[s.Key]
	if !ok {
		return nil, fmt.Errorf("local: no run for session %q", s.Key)
	}
	return p, nil
}

// Steer writes message to the session once its output has been unchanged for three samples a
// second apart, as one bracketed paste (or as raw keys when built with input.Raw). A preset
// without Steer, such as the pinned claude -p argv, and an unknown session return ErrUnsupported.
func (d *Dispatcher) Steer(ctx context.Context, s api.Session, message string) error {
	p, err := d.run(s)
	if err != nil || p.q == nil {
		return ErrUnsupported
	}
	ctx, stop := context.WithCancel(ctx)
	defer stop()
	go func() { // ends with the call or the process
		select {
		case <-p.done:
			stop()
		case <-ctx.Done():
		}
	}()
	return p.q.Send(ctx, message)
}

// Cancel sends the session's process group SIGINT, kills it if it is still running after
// CloseTimeout, and waits for the process to be reaped. A session that is unknown or already
// finished is not an error.
func (d *Dispatcher) Cancel(ctx context.Context, s api.Session) error {
	p, err := d.run(s)
	if err != nil {
		return nil
	}
	if err := input.Close(ctx, d.cfg.Clock, func() error { return interruptGroup(p.cmd) }, func() error { p.cancel(); return nil }, p.done, d.cfg.CloseTimeout); err != nil {
		return err
	}
	select {
	case <-p.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Usage returns the totals read from the run's stream-json output so far.
func (d *Dispatcher) Usage(_ context.Context, s api.Session) (api.Usage, error) {
	p, err := d.run(s)
	if err != nil {
		return api.Usage{}, err
	}
	u := p.usage.get()
	select {
	case <-p.done:
		u.WallTime = p.end.Sub(p.start)
	default:
		u.WallTime = d.cfg.Now().Sub(p.start)
	}
	return u, nil
}

type tokenUsage struct {
	Input      int64 `json:"input_tokens"`
	Output     int64 `json:"output_tokens"`
	CacheRead  int64 `json:"cache_read_input_tokens"`
	CacheWrite int64 `json:"cache_creation_input_tokens"`
}

// feed reads one line of Claude Code's stream-json. Assistant lines add their
// per-message usage; the result line carries cumulative totals. The reported
// usage never goes down, so the meter's decrease check cannot trip on it.
func (s *usageState) feed(line []byte) {
	var l struct {
		Type    string `json:"type"`
		Message struct {
			Usage *tokenUsage `json:"usage"`
		} `json:"message"`
		Usage *tokenUsage `json:"usage"`
		Cost  *float64    `json:"cost_usd"`
		Total *float64    `json:"total_cost_usd"`
	}
	if json.Unmarshal(line, &l) != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch l.Type {
	case "assistant":
		if m := l.Message.Usage; m != nil {
			s.u.InputTokens += m.Input
			s.u.OutputTokens += m.Output
			s.u.CacheReadTokens += m.CacheRead
			s.u.CacheWriteTokens += m.CacheWrite
		}
	case "result":
		if t := l.Usage; t != nil {
			s.u.InputTokens = max(s.u.InputTokens, t.Input)
			s.u.OutputTokens = max(s.u.OutputTokens, t.Output)
			s.u.CacheReadTokens = max(s.u.CacheReadTokens, t.CacheRead)
			s.u.CacheWriteTokens = max(s.u.CacheWriteTokens, t.CacheWrite)
		}
		cost := l.Total
		if cost == nil {
			cost = l.Cost
		}
		if cost != nil && *cost > s.u.CostUSD {
			s.u.CostUSD = *cost
		}
	}
}

func (s *usageState) get() api.Usage {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.u
}

var _ api.Dispatcher = (*Dispatcher)(nil)
