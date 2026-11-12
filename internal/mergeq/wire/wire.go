package wire

import (
	"errors"
	"os"

	"github.com/KaaS-team/factory/internal/gitx"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/tracker/github"
	gogithub "github.com/google/go-github/v79/github"
)

var _ mergeq.Tracker = (*github.Tracker)(nil)

// New builds the merge queue over the repository clone at dir (remote origin, base branch main),
// the GitHub tracker tr and the go-github client for owner/repo.
func New(tr *github.Tracker, dir string, cfg mergeq.Config, client *gogithub.Client, owner, repo string) (*mergeq.CoreQueue, error) {
	switch {
	case tr == nil:
		return nil, errors.New("wire: tracker is required")
	case client == nil:
		return nil, errors.New("wire: GitHub client is required")
	case owner == "" || repo == "":
		return nil, errors.New("wire: owner and repo are required")
	}
	if st, err := os.Stat(dir); err != nil || !st.IsDir() {
		return nil, errors.New("wire: " + dir + " is not a directory")
	}
	g := gitx.New(dir)
	return mergeq.NewCoreQueue(mergeq.Deps{
		Tracker: tr,
		Git:     Git{G: g},
		Gate:    Gate{G: g},
		Heads:   Heads{Client: client, Owner: owner, Repo: repo},
		Cfg:     cfg,
	}), nil
}
