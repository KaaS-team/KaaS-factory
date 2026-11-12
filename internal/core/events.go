package core

// Event kinds published on the stream. Every Event carries api.EventVersion, the
// time from the Core's clock and, when it is about one ticket, the ticket id.
// Data keys are listed per kind.
const (
	// KindTick ends every pass of the loop. Data: slots (running count), ready, queued.
	KindTick = "tick"
	// KindDispatched is a session start, by the loop or by Control.Dispatch. Data: attempt, session.
	KindDispatched = "dispatched"
	// KindSteered is an operator Control.Steer reaching the session. Data: message.
	KindSteered = "steered"
	// KindCreated is an operator Control.CreateTicket filing a ticket. Data: title.
	KindCreated = "created"
	// KindHandedOff is an operator Control.HandOff. Data: to.
	KindHandedOff = "handed_off"
	// KindFollowup is an operator Control.QueueFollowup. Data: message.
	KindFollowup = "followup"
	// KindCanceled is an operator Control.Cancel. Data: attempt.
	KindCanceled = "canceled"
	// KindRetried is a new attempt, by an operator Control.Retry or by the loop
	// moving a ticket to the retry queue. Data: attempt, and manual (true for an operator).
	KindRetried = "retried"
	// KindStalled is the loop steering a session that has not pushed for stall_after. Data: message.
	KindStalled = "stalled"
	// KindPushed is a newer push seen on a ticket's work branch. Data: attempt, branch.
	KindPushed = "pushed"
	// KindGate is a merge queue pass that ran the gate. Data: runs.
	KindGate = "gate"
	// KindQueued is a finished ticket entering the merge queue. Data: pr.
	KindQueued = "queued"
	// KindMerged is a ticket landed by the merge queue. Data: pr.
	KindMerged = "merged"
	// KindNeedsHuman is the factory giving up on a ticket. Data: reason, when known.
	KindNeedsHuman = "needs_human"
	// KindStage is a ticket moving to another workflow node. Data: node, after, outcome.
	KindStage = "stage"
	// KindWarning is something the core worked around, such as a workflow edited under a running ticket. Data: reason.
	KindWarning = "warning"
	// KindBudget is the meter asking a session to wrap up or stopping it. Data: verdict.
	KindBudget = "budget"
	// KindSubscriberDropped is sent to the remaining subscribers when one fell behind
	// and was closed. Data: buffer.
	KindSubscriberDropped = "subscriber_dropped"
)
