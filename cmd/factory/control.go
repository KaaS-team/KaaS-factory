package main

import (
	"errors"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
)

// newControl builds the api.Control every command talks to. Tests replace it with a fake.
// The default fails until the supervisor wires internal/core.
var newControl = func(config.Config) (api.Control, error) {
	return nil, errors.New("core not wired yet: this build has no orchestrator behind api.Control")
}
