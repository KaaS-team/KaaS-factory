package smoke

import (
	"context"
	"os"
	"testing"
	"time"
)

// liveConfig skips unless the operator opted in, and sets up git credentials for the run.
func liveConfig(t *testing.T) Config {
	t.Helper()
	e, skip := FromEnv(os.Getenv)
	if skip != "" {
		t.Skip("live smoke test is opt-in: " + skip)
	}
	for k, v := range GitAuthEnv(e.Token) {
		t.Setenv(k, v)
	}
	return Config{Owner: e.Owner, Repo: e.Repo, Token: e.Token, Dir: t.TempDir(), Poll: 5 * time.Second, Timeout: 10 * time.Minute}
}

func liveRun(t *testing.T, cfg Config) Result {
	t.Helper()
	res, err := Run(context.Background(), cfg)
	t.Cleanup(func() {
		if err := Cleanup(context.Background(), cfg, res); err != nil {
			t.Errorf("cleanup: %v", err)
		}
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	return res
}

// TestLive drives the real loop against FACTORY_SMOKE_REPO: the issue ends merged and the file is
// on the base branch.
func TestLive(t *testing.T) {
	res := liveRun(t, liveConfig(t))
	if res.PR == 0 || !res.Merged || !res.FileOnBase {
		t.Fatalf("not landed: %+v", res)
	}
}

// TestLiveShadow is the same run in shadow mode: nothing merged and no comment written.
func TestLiveShadow(t *testing.T) {
	cfg := liveConfig(t)
	cfg.Shadow = true
	res := liveRun(t, cfg)
	if res.PR != 0 || res.Merged || res.FileOnBase || res.Comments != 0 {
		t.Fatalf("shadow run changed the repo: %+v", res)
	}
}
