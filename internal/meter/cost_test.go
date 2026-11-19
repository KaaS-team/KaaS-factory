package meter

import (
	"testing"
	"time"
)

var day0 = time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)

func days(n int) time.Time { return day0.AddDate(0, 0, n) }

func TestCostPerSurvivingPR(t *testing.T) {
	rows := []Spend{{CostUSD: 6}, {CostUSD: 4}}
	for _, tc := range []struct {
		name  string
		prs   []PR
		churn time.Duration
		want  CostSummary
	}{
		{"no PRs", nil, 0, CostSummary{SpendUSD: 10}},
		{"one reverted inside the window", []PR{{Number: 1, MergedAt: days(0), RevertedAt: days(3)}}, 0,
			CostSummary{Merged: 1, SpendUSD: 10, RevertRate: 1}},
		{"revert outside the window survives", []PR{{Number: 1, MergedAt: days(0), RevertedAt: days(20)}}, 0,
			CostSummary{Merged: 1, Surviving: 1, SpendUSD: 10, CostPerPRUSD: 10}},
		{"revert on the last day still counts", []PR{{Number: 1, MergedAt: days(0), RevertedAt: days(14)}}, 0,
			CostSummary{Merged: 1, SpendUSD: 10, RevertRate: 1}},
		{"custom window", []PR{{Number: 1, MergedAt: days(0), RevertedAt: days(3)}}, 48 * time.Hour,
			CostSummary{Merged: 1, Surviving: 1, SpendUSD: 10, CostPerPRUSD: 10}},
		{"mixed", []PR{{Number: 1, MergedAt: days(0)}, {Number: 2, MergedAt: days(1), RevertedAt: days(2)}}, 0,
			CostSummary{Merged: 2, Surviving: 1, SpendUSD: 10, CostPerPRUSD: 10, RevertRate: 0.5}},
	} {
		if got := CostPerSurvivingPR(rows, tc.prs, tc.churn); got != tc.want {
			t.Errorf("%s: got %+v, want %+v", tc.name, got, tc.want)
		}
	}
}

func TestDetectReverts(t *testing.T) {
	prs := []PR{
		{Number: 12, MergedAt: days(0), SHA: "abcdef1234567890"},
		{Number: 120, MergedAt: days(0), SHA: "1111111222"},
		{Number: 5, MergedAt: days(0), SHA: "deadbeefcafe0000"},
		{Number: 6, MergedAt: days(5)},
	}
	changes := []Change{
		{At: days(2), Title: `Revert "Add thing (#12)"`},
		{At: days(1), Title: `Revert "Other (#120)"`}, // names 120, not 12
		{At: days(4), Message: "Revert x\n\nThis reverts commit deadbeefcafe."},
		{At: days(3), Title: `Revert "Late (#6)"`},        // before PR 6 merged? no: 6 merged day 5
		{At: days(1), Title: `Add thing again (#12)`},     // not a revert title
		{At: days(1), Message: "This reverts commit abc"}, // too short a sha
	}
	got := DetectReverts(prs, changes)
	if !got[0].RevertedAt.Equal(days(2)) {
		t.Errorf("#12 reverted at %v", got[0].RevertedAt)
	}
	if !got[1].RevertedAt.Equal(days(1)) {
		t.Errorf("#120 reverted at %v", got[1].RevertedAt)
	}
	if !got[2].RevertedAt.Equal(days(4)) {
		t.Errorf("sha revert = %v", got[2].RevertedAt)
	}
	if !got[3].RevertedAt.IsZero() {
		t.Errorf("revert before merge counted: %v", got[3].RevertedAt)
	}
	if !prs[0].RevertedAt.IsZero() {
		t.Error("input mutated")
	}
}
