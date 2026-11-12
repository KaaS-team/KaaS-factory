package main

import (
	"context"
	"fmt"

	gogithub "github.com/google/go-github/v79/github"

	"github.com/KaaS-team/factory/internal/firstrun"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/observe/ghsource"
)

// draftPRs opens the draft pull request `factory first-run --fix` ends with.
type draftPRs struct {
	c           *gogithub.Client
	owner, repo string
}

func (d draftPRs) OpenDraft(ctx context.Context, branch, base, title, body string) (int, error) {
	pr, _, err := d.c.PullRequests.Create(ctx, d.owner, d.repo, &gogithub.NewPullRequest{
		Title: &title, Head: &branch, Base: &base, Body: &body, Draft: gogithub.Ptr(true),
	})
	if err != nil {
		return 0, err
	}
	return pr.GetNumber(), nil
}

// firstRunExec builds what `first-run --fix` needs from the config: the configured dispatcher, and the
// repository's pull requests and checks on GitHub. It runs only under --fix, so a report needs no token.
func firstRunExec(ctx context.Context) (firstrun.Exec, error) {
	l, err := loadConfig(nil)
	if err != nil {
		return firstrun.Exec{}, err
	}
	c := l.Config
	build, ok := dispatchers[c.Dispatcher]
	if !ok {
		return firstrun.Exec{}, fmt.Errorf("first-run --fix: unknown dispatcher %q", c.Dispatcher)
	}
	g, err := newGitHubConn(c)
	if err != nil {
		return firstrun.Exec{}, fmt.Errorf("first-run --fix: %w", err)
	}
	client, err := g.client()
	if err != nil {
		return firstrun.Exec{}, err
	}
	d, err := build(ctx, c)
	if err != nil {
		return firstrun.Exec{}, err
	}
	return firstrun.Exec{
		Dispatcher: d,
		PRs:        draftPRs{client, g.owner, g.repo},
		Observer:   observe.New(ghsource.New(client, g.owner, g.repo, c.Base)),
		Repo:       c.Repo,
		Base:       c.Base,
	}, nil
}
