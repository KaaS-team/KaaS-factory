// Package api is the one contract every part of the factory shares.
//
// The core (reconcile, pick, mergeq, meter) talks to the outside world only
// through the ports below, and every client (CLI, TUI, MCP, dashboard, a
// future business UI) talks to the core only through Control and the Event
// stream. Changing a type here is a versioned change: bump EventVersion when
// an Event field changes meaning.
package api

import (
	"context"
	"time"
)

// EventVersion is the schema version written into every NDJSON event.
const EventVersion = 1

// TicketID is a tracker-native id: "123" for GitHub, "ENG-42" for Linear/Jira.
type TicketID string

// Phase is where a ticket stands in the orchestrator's state machine
// (Symphony §7 claim states, plus the merge stages).
type Phase string

const (
	PhaseReady      Phase = "ready"       // eligible, unclaimed
	PhaseClaimed    Phase = "claimed"     // slot reserved, brief being published
	PhaseRunning    Phase = "running"     // session dispatched, no report yet
	PhaseStalled    Phase = "stalled"     // no push within stall_after
	PhaseRetryQueue Phase = "retry"       // waiting for backoff before the next attempt
	PhaseDone       Phase = "done"        // branch + report + PR exist
	PhaseQueued     Phase = "merge-queue" // in the merge queue
	PhaseMerged     Phase = "merged"
	PhaseNeedsHuman Phase = "needs-human"
	PhaseCanceled   Phase = "canceled"
)

// Ticket is one unit of work. Files is the declared write set used for
// overlap checks before dispatch.
type Ticket struct {
	ID        TicketID   `json:"id"`
	Repo      string     `json:"repo"`
	Title     string     `json:"title"`
	Body      string     `json:"body"`
	Labels    []string   `json:"labels,omitempty"`
	Files     []string   `json:"files,omitempty"`
	BlockedBy []TicketID `json:"blocked_by,omitempty"`
	Priority  int        `json:"priority"` // lower runs first (0 = P0)
	Workflow  string     `json:"workflow,omitempty"`
	CreatedAt time.Time  `json:"created_at"`
}

// Budget caps one node, ticket or team-day. Zero means "no cap at this level".
type Budget struct {
	Tokens    int64         `json:"tokens,omitempty"`
	USD       float64       `json:"usd,omitempty"`
	WallClock time.Duration `json:"wall_clock,omitempty"`
}

// Brief is what a session is told to do. Name is the file name on the
// briefs branch; Text is its full content.
type Brief struct {
	Ticket   TicketID `json:"ticket"`
	Attempt  int      `json:"attempt"`
	Name     string   `json:"name"`
	Text     string   `json:"text"`
	Repo     string   `json:"repo"`
	Base     string   `json:"base"`
	Branch   string   `json:"branch"` // factory/<ticket>-a<attempt>
	Model    string   `json:"model,omitempty"`
	Agent    string   `json:"agent,omitempty"` // agent preset name
	Budget   Budget   `json:"budget"`
	Workflow string   `json:"workflow,omitempty"`
	Node     string   `json:"node,omitempty"`
}

// Session is a dispatched run. Key is deterministic per (ticket, attempt) so
// a retried Dispatch after a crash finds the same session (spec 401).
type Session struct {
	Key        string    `json:"key"`
	ID         string    `json:"id"`
	URL        string    `json:"url,omitempty"`
	Ticket     TicketID  `json:"ticket"`
	Attempt    int       `json:"attempt"`
	Dispatcher string    `json:"dispatcher"`
	StartedAt  time.Time `json:"started_at"`
}

// Usage is token and time accounting for one session or node. Values are
// absolute totals; the meter derives deltas (Symphony §13.5).
type Usage struct {
	InputTokens      int64         `json:"input_tokens"`
	OutputTokens     int64         `json:"output_tokens"`
	CacheReadTokens  int64         `json:"cache_read_tokens"`
	CacheWriteTokens int64         `json:"cache_write_tokens"`
	CostUSD          float64       `json:"cost_usd,omitempty"` // 0 = unknown, never guessed
	WallTime         time.Duration `json:"wall_time"`
}

// Observation is what the outside world says about a ticket right now.
// Completion is read from git and the tracker, never from session status.
type Observation struct {
	Ticket      TicketID  `json:"ticket"`
	Attempt     int       `json:"attempt"`
	Branch      string    `json:"branch,omitempty"`
	LastPush    time.Time `json:"last_push,omitempty"`
	HasReport   bool      `json:"has_report"`
	PR          int       `json:"pr,omitempty"`
	ChecksGreen *bool     `json:"checks_green,omitempty"` // nil = pending or none
	DiffFiles   []string  `json:"diff_files,omitempty"`
	Usage       Usage     `json:"usage"`
}

// Caps describes what a dispatcher can do.
type Caps struct {
	MaxConcurrent    int  `json:"max_concurrent"`
	FiresPerHour     int  `json:"fires_per_hour,omitempty"` // 0 = no limit
	CanPushWorkflows bool `json:"can_push_workflows"`       // cloud tokens cannot push .github/workflows
	Remote           bool `json:"remote"`
}

// Dispatcher starts and controls sessions: RemoteTrigger routines, the
// documented routine fire endpoint, or a local agent CLI.
type Dispatcher interface {
	Name() string
	Caps() Caps
	Dispatch(ctx context.Context, b Brief) (Session, error)
	Steer(ctx context.Context, s Session, message string) error
	Cancel(ctx context.Context, s Session) error
	Usage(ctx context.Context, s Session) (Usage, error)
}

// Tracker is the system of record for tickets: GitHub, Linear or Jira.
// Only two reads are required (Symphony §11); writes go through the thread.
type Tracker interface {
	Name() string
	Ready(ctx context.Context) ([]Ticket, error)
	Get(ctx context.Context, id TicketID) (Ticket, error)
	Comment(ctx context.Context, id TicketID, body string) error
	SetPhase(ctx context.Context, id TicketID, p Phase) error
}

// Observer reads git and the tracker to describe a ticket's run.
type Observer interface {
	Observe(ctx context.Context, id TicketID, attempt int) (Observation, error)
}

// Event is one line of the NDJSON stream (`factory run --headless`).
type Event struct {
	V      int            `json:"v"`
	Time   time.Time      `json:"time"`
	Kind   string         `json:"kind"`
	Ticket TicketID       `json:"ticket,omitempty"`
	Data   map[string]any `json:"data,omitempty"`
}

// Slot is one row of the board.
type Slot struct {
	Ticket   Ticket    `json:"ticket"`
	Phase    Phase     `json:"phase"`
	Session  *Session  `json:"session,omitempty"`
	LastPush time.Time `json:"last_push,omitempty"`
	Usage    Usage     `json:"usage"`
	Budget   Budget    `json:"budget"`
}

// Board is the whole orchestrator state as clients see it.
type Board struct {
	Slots      []Slot     `json:"slots"`
	Ready      []Ticket   `json:"ready"`
	MergeQueue []TicketID `json:"merge_queue"`
	FiresLeft  int        `json:"fires_left"`
}

// Control is the API every client uses.
type Control interface {
	Board(ctx context.Context) (Board, error)
	Dispatch(ctx context.Context, id TicketID) error
	Steer(ctx context.Context, id TicketID, message string) error
	Cancel(ctx context.Context, id TicketID) error
	Retry(ctx context.Context, id TicketID) error
	Events(ctx context.Context) (<-chan Event, error)
}
