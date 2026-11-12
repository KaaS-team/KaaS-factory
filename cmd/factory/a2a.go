package main

import (
	"context"
	"fmt"

	"github.com/KaaS-team/factory/internal/a2a"
	"github.com/KaaS-team/factory/internal/config"
)

// a2aDeps builds what the A2A server reaches: the GitHub tracker files and reads tickets, the store
// holds phases, and the observer finds the pull request. Other trackers cannot file tickets here.
func a2aDeps(context.Context) (a2a.Deps, error) {
	l, err := loadConfig(nil)
	if err != nil {
		return a2a.Deps{}, err
	}
	return a2aDepsFor(l.Config)
}

func a2aDepsFor(c config.Config) (a2a.Deps, error) {
	if c.Tracker != "github" {
		return a2a.Deps{}, fmt.Errorf("a2a: filing tickets needs tracker github, not %q", c.Tracker)
	}
	g, err := newGitHubConn(c)
	if err != nil {
		return a2a.Deps{}, err
	}
	tr, err := g.tracker()
	if err != nil {
		return a2a.Deps{}, err
	}
	obs, _, err := gitHubParts(c, tr)
	if err != nil {
		return a2a.Deps{}, err
	}
	st, err := openStore()
	if err != nil {
		return a2a.Deps{}, err
	}
	return a2a.Deps{Tracker: tr, Filer: tr, Phases: st, Observer: obs}, nil
}
