package meter

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

// DefaultChurnWindow is how long after merge a revert still counts against the PR.
const DefaultChurnWindow = 14 * 24 * time.Hour

// PR is one merged pull request. A zero RevertedAt means it was never reverted.
type PR struct {
	Number     int
	MergedAt   time.Time
	RevertedAt time.Time
	Title      string // used by DetectReverts only
	SHA        string // merge commit, used by DetectReverts only
}

// CostSummary is the cost per surviving merged PR: all recorded spend divided by the merged PRs
// that were not reverted within the churn window.
type CostSummary struct {
	Merged       int     `json:"merged"`
	Surviving    int     `json:"surviving"`
	SpendUSD     float64 `json:"spend_usd"`
	CostPerPRUSD float64 `json:"cost_per_surviving_pr_usd"` // 0 when nothing survived
	RevertRate   float64 `json:"revert_rate"`               // reverted within the window, over merged
}

// CostPerSurvivingPR sums every row's cost (verify, review and rework runs included) and divides by
// the PRs that survived. A churn of zero or less means DefaultChurnWindow. A PR is reverted when
// RevertedAt is set and falls no later than MergedAt plus the window.
func CostPerSurvivingPR(rows []Spend, prs []PR, churn time.Duration) CostSummary {
	if churn <= 0 {
		churn = DefaultChurnWindow
	}
	var s CostSummary
	for _, r := range rows {
		s.SpendUSD += r.CostUSD
	}
	s.Merged = len(prs)
	for _, p := range prs {
		if p.RevertedAt.IsZero() || p.RevertedAt.After(p.MergedAt.Add(churn)) {
			s.Surviving++
		}
	}
	if s.Surviving > 0 {
		s.CostPerPRUSD = s.SpendUSD / float64(s.Surviving)
	}
	if s.Merged > 0 {
		s.RevertRate = float64(s.Merged-s.Surviving) / float64(s.Merged)
	}
	return s
}

// Change is a later merged PR or a commit that may revert an earlier PR.
type Change struct {
	At      time.Time
	Title   string // a PR title, empty for a commit
	Message string // a commit message, empty for a PR
}

var revertsCommit = regexp.MustCompile(`(?m)^This reverts commit ([0-9a-fA-F]{7,40})`)

// DetectReverts returns prs with RevertedAt set from the earliest later change that reverts each.
// A change reverts PR n when its title starts with `Revert "` and names #n, or when its message
// says `This reverts commit <sha>` for the PR's merge commit (a prefix of seven or more digits).
func DetectReverts(prs []PR, changes []Change) []PR {
	out := make([]PR, len(prs))
	copy(out, prs)
	for i, p := range out {
		for _, c := range changes {
			if !c.At.After(p.MergedAt) || !reverts(p, c) {
				continue
			}
			if p.RevertedAt.IsZero() || c.At.Before(p.RevertedAt) {
				out[i].RevertedAt = c.At
			}
		}
	}
	return out
}

func reverts(p PR, c Change) bool {
	if strings.HasPrefix(c.Title, `Revert "`) && p.Number > 0 &&
		regexp.MustCompile(`#`+strconv.Itoa(p.Number)+`\b`).MatchString(c.Title) {
		return true
	}
	if p.SHA == "" {
		return false
	}
	for _, m := range revertsCommit.FindAllStringSubmatch(c.Message, -1) {
		if strings.HasPrefix(strings.ToLower(p.SHA), strings.ToLower(m[1])) {
			return true
		}
	}
	return false
}
