// Package conformance maps the Symphony spec's test matrix (section 17) and
// definition of done (section 18.1) onto tests that run against the
// reconcile and pick code. Run it with `go test ./internal/conformance -run Test17`.
package conformance

// Item is one row of the spec's test matrix or one checklist line. Exactly one
// of Test and NotApplicable is set. Note records where our behavior differs
// from the spec text, or what the named test does not cover.
type Item struct {
	Ref           string   // spec section, for example "17.4" or "18.1"
	Text          string   // the spec line, shortened
	Test          string   // name of the Test17_ function that proves it
	Also          []string // further Test17_ functions that prove other parts of the line
	NotApplicable string   // why this suite does not test it
	Note          string
}

const (
	outsideScheduler = "Outside the scheduler: not in reconcile, pick or dispatch, so this suite does not prove it."
	noSnapshot       = "Optional extension; reconcile has no snapshot API."
	noRealRun        = "Real integration profile; needs credentials and a network, so it never runs in this suite."
	notCLI           = "CLI behavior lives in cmd/factory, not in the scheduler."
)

func na(ref, text, reason string) Item { return Item{Ref: ref, Text: text, NotApplicable: reason} }
func tc(ref, text, test, note string) Item {
	return Item{Ref: ref, Text: text, Test: test, Note: note}
}

func withAlso(it Item, more ...string) Item { it.Also = more; return it }

// Rows17 lists every row of spec section 17.1 to 17.8 and what covers it.
func Rows17() []Item {
	return []Item{
		// 17.1 Workflow and config parsing: config package.
		na("17.1", "Workflow path precedence", outsideScheduler),
		na("17.1", "Workflow file changes trigger re-read without restart", outsideScheduler),
		na("17.1", "Invalid reload keeps last known good config", outsideScheduler),
		na("17.1", "Missing WORKFLOW.md returns typed error", outsideScheduler),
		na("17.1", "Invalid YAML front matter returns typed error", outsideScheduler),
		na("17.1", "Front matter non-map returns typed error", outsideScheduler),
		na("17.1", "Config defaults apply", outsideScheduler),
		na("17.1", "tracker.kind validation", outsideScheduler),
		na("17.1", "tracker.provider keys preserved and validated", outsideScheduler),
		na("17.1", "$VAR resolution", outsideScheduler),
		na("17.1", "~ path expansion", outsideScheduler),
		na("17.1", "codex.command kept as a shell string", outsideScheduler),
		na("17.1", "Per-state concurrency override map", outsideScheduler),
		na("17.1", "Prompt template renders issue and attempt", outsideScheduler),
		na("17.1", "Prompt rendering fails on unknown variables", outsideScheduler),
		// 17.2 Workspace manager: no workspaces in the scheduler.
		na("17.2", "Deterministic workspace path per identifier", outsideScheduler),
		na("17.2", "Missing workspace directory is created", outsideScheduler),
		na("17.2", "Existing workspace directory is reused", outsideScheduler),
		na("17.2", "Non-directory path at workspace location", outsideScheduler),
		na("17.2", "Workspace population errors are surfaced", outsideScheduler),
		na("17.2", "after_create hook only on new workspace", outsideScheduler),
		na("17.2", "before_run hook aborts the attempt on failure", outsideScheduler),
		na("17.2", "after_run hook failures are ignored", outsideScheduler),
		na("17.2", "before_remove hook failures are ignored", outsideScheduler),
		na("17.2", "Sanitization, collision resistance, root containment", outsideScheduler),
		na("17.2", "Distinct identifiers that sanitize alike keep distinct keys", outsideScheduler),
		na("17.2", "Agent launch uses the workspace as cwd", outsideScheduler),
		// 17.3 Tracker adapter: tracker packages.
		na("17.3", "Candidate fetch applies active states and scope", outsideScheduler),
		na("17.3", "Empty fetch_issues_by_states returns empty without a call", outsideScheduler),
		na("17.3", "Empty fetch_issues_by_ids returns empty without a call", outsideScheduler),
		na("17.3", "Pagination preserves order", outsideScheduler),
		na("17.3", "Labels normalized to lowercase", outsideScheduler),
		na("17.3", "Unusable optional metadata normalizes to empty", outsideScheduler),
		na("17.3", "State-list reads log malformed records; ID refresh fails them", outsideScheduler),
		na("17.3", "Refresh by dispatch ID returns full snapshots", outsideScheduler),
		na("17.3", "Distinct provider ID kept in native_ref", outsideScheduler),
		na("17.3", "Provider rules become explicit dispatchable", outsideScheduler),
		na("17.3", "Adapter publishes its compact profile", outsideScheduler),
		na("17.3", "Error mapping covers the documented categories", outsideScheduler),
		// 17.4 Dispatch, reconciliation and retry.
		tc("17.4", "Dispatch sort order is priority then oldest creation time", "Test17_4_DispatchSortOrder",
			"Spec sorts priority 1..4 before every other value; we rank lower first, so 0 (P0) runs first. Asserted as our contract."),
		na("17.4", "dispatchable=false issues are not eligible", "api.Ticket has no dispatchable field; the Tracker port returns only eligible tickets from Ready."),
		na("17.4", "Required-label filtering is case-insensitive", "reconcile.Config has no required labels; the tracker adapter filters before Ready."),
		tc("17.4", "Active-state issue refresh updates running entry state", "Test17_4_ActiveRefreshUpdatesRunning", ""),
		tc("17.4", "Non-active state stops running agent without workspace cleanup", "Test17_4_NonActiveStopsWithoutCleanup",
			"A ticket missing from Ready is treated as terminal; there is no separate non-active state."),
		tc("17.4", "Terminal state stops running agent and cleans workspace", "Test17_4_TerminalStopsRunning",
			"Proves the stop only. reconcile has no workspace manager, so cleanup is not tested here."),
		tc("17.4", "Reconciliation with no running issues is a no-op", "Test17_4_NoRunningIsNoop", ""),
		na("17.4", "Normal worker exit schedules a continuation retry (attempt 1)",
			"Completion is read from branch, report and PR; a finished ticket goes to done and no continuation retry exists."),
		tc("17.4", "Abnormal worker exit increments retries with 10s exponential backoff", "Test17_4_AbnormalExitBackoff", ""),
		tc("17.4", "Retry backoff cap", "Test17_4_BackoffFormula",
			"Config.MaxRetryBackoff (default 5m) sets the cap; Test17_4_ConfiguredBackoffCap proves 1m caps attempt 8."),
		tc("17.4", "Retry queue entries include attempt, due time, identifier and error", "Test17_4_RetryEntryFields",
			"Entry.Error holds the retry reason: the stall, or the dispatch error text."),
		withAlso(tc("17.4", "Stall detection kills stalled sessions and schedules retry", "Test17_4_StallKillsAndQueuesRetry",
			"Also proves 8.5: a failed observer refresh makes no stall decision, and 8.1: a failed tracker read still runs stall checks."),
			"Test17_4_ObserverFailureKeepsWorker", "Test17_4_TrackerFailureStillReconciles"),
		tc("17.4", "Slot exhaustion requeues retries with explicit error reason", "Test17_4_SlotExhaustionKeepsRetryQueued",
			"The retry stays queued with the Requeue action recording the reason (Entry.Error)."),
		na("17.4", "Snapshot API returns running rows, retry rows, token totals, rate limits", noSnapshot),
		na("17.4", "Snapshot API surfaces timeout and unavailable cases", noSnapshot),
		// 17.5 App-server client: dispatch adapters.
		na("17.5", "Launch command uses workspace cwd and bash -lc", outsideScheduler),
		na("17.5", "Session startup follows the app-server protocol", outsideScheduler),
		na("17.5", "Client identity and capability payloads", outsideScheduler),
		na("17.5", "Approval and sandbox startup payloads", outsideScheduler),
		na("17.5", "Thread and turn identities extracted", outsideScheduler),
		na("17.5", "Request and response read timeout", outsideScheduler),
		na("17.5", "Turn timeout", outsideScheduler),
		na("17.5", "Transport framing", outsideScheduler),
		na("17.5", "Stderr kept separate from the protocol stream", outsideScheduler),
		na("17.5", "Command and file-change approvals", outsideScheduler),
		na("17.5", "Unsupported dynamic tool calls are rejected", outsideScheduler),
		na("17.5", "User input requests do not stall", outsideScheduler),
		na("17.5", "Usage and rate-limit telemetry extracted", outsideScheduler),
		na("17.5", "Approval, input, usage and rate-limit signals interpreted", outsideScheduler),
		na("17.5", "Client-side tools advertised at startup", outsideScheduler),
		na("17.5", "Provider-native agent tools", outsideScheduler),
		// 17.6 Observability.
		tc("17.6", "Validation failures are operator-visible", "Test17_6_ErrorsReachOperator",
			"Covers tracker and observer errors. There is no config validation step in reconcile."),
		na("17.6", "Structured logging includes issue and session fields", "reconcile writes no logs; errors go to Deps.OnError."),
		na("17.6", "Logging sink failures do not crash orchestration", "reconcile writes no logs."),
		na("17.6", "Token and rate-limit aggregation across updates", "Owned by internal/meter, not the scheduler."),
		na("17.6", "Human-readable status surface", noSnapshot),
		na("17.6", "Humanized event summaries", noSnapshot),
		// 17.7 CLI.
		na("17.7", "CLI accepts a positional workflow path", notCLI),
		na("17.7", "CLI uses ./WORKFLOW.md by default", notCLI),
		na("17.7", "CLI errors on a missing workflow file", notCLI),
		na("17.7", "CLI surfaces startup failure cleanly", notCLI),
		na("17.7", "CLI exits with success on normal shutdown", notCLI),
		na("17.7", "CLI exits nonzero on startup failure", notCLI),
		// 17.8 Real integration.
		na("17.8", "Real tracker smoke test", noRealRun),
		na("17.8", "Isolated identifiers and cleanup", noRealRun),
		na("17.8", "Skipped real test reported as skipped", noRealRun),
		na("17.8", "Explicit real profile failures fail the job", noRealRun),
	}
}

// Items18 lists every line of spec section 18.1 and what proves it.
func Items18() []Item {
	return []Item{
		na("18.1", "Workflow path selection", outsideScheduler),
		na("18.1", "WORKFLOW.md loader", outsideScheduler),
		na("18.1", "Typed config layer with defaults and $ resolution", outsideScheduler),
		na("18.1", "Dynamic WORKFLOW.md watch and reload", outsideScheduler),
		withAlso(tc("18.1", "Polling orchestrator with single-authority mutable state", "Test17_4_NoDuplicateDispatch", "Section 8.1 tick order, 14.3 restart and dispatch idempotence are the extra tests."),
			"Test17_4_TickOrder", "Test17_4_ClaimStatesHoldSlots", "Test17_4_RestartRebuildsRunningSet", "Test17_4_DispatchIdempotentPerAttempt", "Test17_4_InitialLocksHoldFiles"),
		na("18.1", "Tracker adapter with state-list and ID-refresh reads", outsideScheduler),
		na("18.1", "Workspace manager", outsideScheduler),
		na("18.1", "Workspace lifecycle hooks", outsideScheduler),
		na("18.1", "Hook timeout config", outsideScheduler),
		na("18.1", "App-server subprocess client", outsideScheduler),
		na("18.1", "Codex launch command config", outsideScheduler),
		na("18.1", "Strict prompt rendering", outsideScheduler),
		tc("18.1", "Exponential retry queue with continuation retries after normal exit", "Test17_4_AbnormalExitBackoff",
			"Continuation retries do not exist (see the 17.4 not-applicable row)."),
		tc("18.1", "Configurable retry backoff cap", "Test17_4_ConfiguredBackoffCap", "Config.MaxRetryBackoff, default 5 minutes."),
		tc("18.1", "Reconciliation stops runs on terminal and non-active states", "Test17_4_NonActiveStopsWithoutCleanup", ""),
		na("18.1", "Workspace cleanup for terminal issues", outsideScheduler),
		na("18.1", "Structured logs with issue and session ids", "reconcile writes no logs; errors go to Deps.OnError."),
		tc("18.1", "Operator-visible observability", "Test17_6_ErrorsReachOperator", "Errors only; no snapshot surface."),
	}
}
