package main

import (
	"os"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/spf13/pflag"
)

// loadConfig resolves the config from the repo file in the working directory, the environment and
// the flags the user set on fs (nil for none).
func loadConfig(fs *pflag.FlagSet) (*config.Loaded, error) {
	repo, err := config.ReadRepo(os.DirFS("."))
	if err != nil {
		return nil, err
	}
	return config.Load(config.Sources{Repo: repo, Env: os.Environ(), Flags: fs})
}
