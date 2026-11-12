// Package github implements api.Tracker over the GitHub issue thread, which is
// the only state the factory keeps. It also holds the comment marker codec,
// the ChatOps parser with its trust rule, and the PR body renderer; all three
// are ported from the v8 TypeScript runner and keep its wire formats.
package github

import "github.com/KaaS-team/factory/internal/api"

// Label names, ported from src/labels.ts. They are the only place a factory label is spelled.
const (
	LabelReady            = "factory:ready"
	LabelBlocked          = "factory:blocked"
	LabelOverlap          = "factory:overlap"
	LabelTriaging         = "factory:triaging"
	LabelPlanning         = "factory:planning"
	LabelAwaitingApproval = "factory:awaiting-approval"
	LabelBuilding         = "factory:building"
	LabelVerifying        = "factory:verifying"
	LabelInReview         = "factory:in-review"
	LabelNeedsInfo        = "factory:needs-info"
	LabelNeedsHuman       = "factory:needs-human"
	LabelFailed           = "factory:failed"
	LabelMonitor          = "factory:monitor"
	LabelLedger           = "factory:ledger"
)

// ownedLabels are the lifecycle labels the tracker may add and remove: the
// state labels plus the parked ones. Type labels, provenance labels
// (monitor, ledger) and every label a human added are never touched.
var ownedLabels = map[string]bool{
	LabelReady: true, LabelBlocked: true, LabelOverlap: true, LabelTriaging: true, LabelPlanning: true,
	LabelAwaitingApproval: true, LabelBuilding: true, LabelVerifying: true, LabelInReview: true,
	LabelNeedsInfo: true, LabelNeedsHuman: true, LabelFailed: true,
}

// OwnsLabel reports whether name is a lifecycle label SetPhase may add or remove.
func OwnsLabel(name string) bool { return ownedLabels[name] }

// phaseLabel maps an orchestrator phase to the one lifecycle label that shows it
// on the issue. An empty label means the issue carries none (merged, canceled).
var phaseLabel = map[api.Phase]string{
	api.PhaseReady:      LabelReady,
	api.PhaseClaimed:    LabelBuilding,
	api.PhaseRunning:    LabelBuilding,
	api.PhaseStalled:    LabelBuilding,
	api.PhaseRetryQueue: LabelBuilding,
	api.PhaseDone:       LabelInReview,
	api.PhaseQueued:     LabelInReview,
	api.PhaseMerged:     "",
	api.PhaseNeedsHuman: LabelNeedsHuman,
	api.PhaseCanceled:   "",
}
