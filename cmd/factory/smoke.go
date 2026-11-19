package main

import (
	"fmt"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/smoke"
)

// smokeUsageError is the exit 2 of `factory smoke` when the sandbox repository is not set.
type smokeUsageError struct{ msg string }

func (e smokeUsageError) Error() string { return e.msg }
func (smokeUsageError) ExitCode() int   { return 2 }

// smokeCmd is `factory smoke`: one real run of the loop against the sandbox repository that
// FACTORY_SMOKE_REPO names, with a fake agent and no model. See docs/smoke.md.
func smokeCmd() *cobra.Command {
	var shadow bool
	var timeout time.Duration
	cmd := &cobra.Command{
		Use:   "smoke",
		Short: "Run the loop once against a sandbox GitHub repository with a fake agent",
		Long: "Opens an issue in the sandbox repository, runs it through the real loop and merge queue with a fake agent\n" +
			"and reads the result back. Set " + smoke.EnvRepo + "=owner/name and " + smoke.EnvToken + ". Use a repository you do not mind writing to.",
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			env, why := smoke.FromEnv(os.Getenv)
			if why != "" {
				return smokeUsageError{fmt.Sprintf("smoke: %s. Set %s=owner/name for a sandbox repository you may write to, and %s to a token that can write issues, pull requests and contents on it", why, smoke.EnvRepo, smoke.EnvToken)}
			}
			dir, err := os.MkdirTemp("", "factory-smoke-")
			if err != nil {
				return err
			}
			defer func() { _ = os.RemoveAll(dir) }()
			for k, v := range smoke.GitAuthEnv(env.Token) {
				_ = os.Setenv(k, v)
			}
			cfg := smoke.Config{Owner: env.Owner, Repo: env.Repo, Token: env.Token, APIURL: os.Getenv(envGitHubURL), Dir: dir, Shadow: shadow, Timeout: timeout}
			res, runErr := smoke.Run(cmd.Context(), cfg)
			out := cmd.OutOrStdout()
			if res.Issue != 0 {
				_, _ = fmt.Fprintf(out, "issue\t#%d\npull request\t#%d\nmerged\t%t\nfile on base\t%t\ndispatches\t%d\n", res.Issue, res.PR, res.Merged, res.FileOnBase, res.Dispatches)
			}
			if err := smoke.Cleanup(cmd.Context(), cfg, res); err != nil && runErr == nil {
				runErr = err
			}
			if runErr == nil && !shadow && (res.PR == 0 || !res.Merged || !res.FileOnBase) {
				runErr = fmt.Errorf("smoke: the work did not land")
			}
			return runErr
		},
	}
	cmd.Flags().BoolVar(&shadow, "shadow", false, "shadow run: nothing is dispatched or merged")
	cmd.Flags().DurationVar(&timeout, "timeout", 5*time.Minute, "how long to wait for the work to land")
	return cmd
}
