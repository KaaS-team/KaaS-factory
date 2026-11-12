// Package agentrun is the stable surface other KaaS modules import to run
// coding agents: the Dispatcher port, the local dispatcher (`claude -p` under
// the operator's login), the cloud routines dispatcher and the token meter.
//
// Every export here is a type alias or a forwarding constructor over an
// internal package, so the exports follow the internal packages and nothing
// is copied. Go forbids importing internal/ from another module; this package
// is the way in.
package agentrun

import (
	"context"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/dispatch/routines"
	"github.com/KaaS-team/factory/internal/meter"
)

// Dispatcher starts and controls agent sessions.
type Dispatcher = api.Dispatcher

// Brief is what a session is told to do.
type Brief = api.Brief

// Budget caps one node, ticket or team-day.
type Budget = api.Budget

// Session is a dispatched run.
type Session = api.Session

// Caps describes what a dispatcher can do.
type Caps = api.Caps

// Usage is token and time accounting for one session.
type Usage = api.Usage

// TicketID is a tracker-native ticket id.
type TicketID = api.TicketID

// LocalConfig configures the local dispatcher.
type LocalConfig = local.Config

// LocalPreset builds the argv and environment for one agent CLI.
type LocalPreset = local.Preset

// LocalRun is what a LocalPreset turns into an argv.
type LocalRun = local.Run

// Worktrees prepares the directory a local run executes in.
type Worktrees = local.Worktrees

// GitWorktrees creates one git worktree per session.
type GitWorktrees = local.GitWorktrees

// RoutinesConfig configures the cloud routines dispatcher.
type RoutinesConfig = routines.Config

// Meter accumulates usage and checks it against budgets.
type Meter = meter.Meter

// Budgets holds one cap per level.
type Budgets = meter.Budgets

// MeterKey names one stream of absolute usage totals.
type MeterKey = meter.Key

// Spent is the usage summed at each level for a key.
type Spent = meter.Spent

// ClaudePreset is the `claude -p` preset.
var ClaudePreset = local.ClaudePreset

// NewLocal returns the local dispatcher. Cancelling ctx kills every run it started.
func NewLocal(ctx context.Context, cfg LocalConfig) (Dispatcher, error) {
	d, err := local.New(ctx, cfg)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// NewRoutines returns the cloud routines dispatcher.
func NewRoutines(cfg RoutinesConfig) (Dispatcher, error) {
	d, err := routines.New(cfg)
	if err != nil {
		return nil, err
	}
	return d, nil
}

// NewMeter returns a Meter that checks against budgets and reads the day from now.
var NewMeter = meter.New
