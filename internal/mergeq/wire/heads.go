package wire

import (
	"context"
	"fmt"

	"github.com/KaaS-team/factory/internal/mergeq"
	gogithub "github.com/google/go-github/v79/github"
)

// Heads is mergeq.Heads over the GitHub pull request API.
type Heads struct {
	Client      *gogithub.Client
	Owner, Repo string
}

var _ mergeq.Heads = Heads{}

// PR reads the pull request's current head commit and whether it is open or merged.
func (h Heads) PR(ctx context.Context, pr int) (mergeq.PRState, error) {
	p, _, err := h.Client.PullRequests.Get(ctx, h.Owner, h.Repo, pr)
	if err != nil {
		return mergeq.PRState{}, fmt.Errorf("wire: read pull request %d: %w", pr, err)
	}
	return mergeq.PRState{Head: p.GetHead().GetSHA(), Open: p.GetState() == "open", Merged: p.GetMerged()}, nil
}
