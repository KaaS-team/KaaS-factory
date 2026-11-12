package observe

import (
	"context"

	"github.com/KaaS-team/factory/internal/api"
)

// The verbs the loop acts on. Other `/factory` verbs belong to the plan stage.
const (
	VerbRetry  = "retry"
	VerbCancel = "cancel"
)

// Command is a trusted operator command found in a ticket's thread. Ref names the comment that
// carries it, so the loop can acknowledge it exactly once.
type Command struct {
	Verb  string
	Ref   int64
	Force bool
}

// Commander is the optional Tracker read of operator commands (chatops). Commands returns the
// unacknowledged retry and cancel commands from trusted authors, oldest first; Ack records that
// one was handled so it is never returned again.
type Commander interface {
	Commands(ctx context.Context, id api.TicketID) ([]Command, error)
	Ack(ctx context.Context, id api.TicketID, ref int64) error
}

// PROpener is the optional Tracker write that opens the draft pull request for a finished
// branch. It returns the new number, or 0 when the branch already had a pull request.
type PROpener interface {
	OpenPR(ctx context.Context, id api.TicketID, branch, base string, files []string) (int, error)
}

// Recorder is the optional Tracker write that keeps the run's status in the thread, so the
// first dispatch and merge times survive a deleted store.
type Recorder interface {
	RecordStatus(ctx context.Context, id api.TicketID, p api.Phase) error
}
