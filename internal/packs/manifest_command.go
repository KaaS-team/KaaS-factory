package packs

import (
	"context"
	"fmt"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

// newRunCommand returns `run <pack.yaml> -- <command>`: it runs the command and re-runs it while the
// manifest's retry checks fail.
func newRunCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:          "run <pack.yaml> -- <command> [args]",
		Short:        "Run a command and retry it while the manifest's success checks fail",
		Args:         cobra.MinimumNArgs(2),
		SilenceUsage: true,
	}
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		m, err := LoadManifest(args[0], "")
		if err != nil {
			return err
		}
		if m.Retry == nil {
			return fmt.Errorf("%s has no retry block", args[0])
		}
		task := func(ctx context.Context) error {
			c := exec.CommandContext(ctx, args[1], args[2:]...)
			c.Stdout, c.Stderr = cmd.OutOrStdout(), cmd.ErrOrStderr()
			return c.Run()
		}
		return m.Retry.Run(cmd.Context(), "", task)
	}
	return cmd
}

// newMatchCommand returns `match <dir>`: it prints the skills in dir whose body would be injected.
func newMatchCommand() *cobra.Command {
	var touched []string
	var text string
	cmd := &cobra.Command{Use: "match <dir>", Short: "List the skill packs whose paths or keywords match", Args: cobra.ExactArgs(1), SilenceUsage: true}
	cmd.Flags().StringSliceVar(&touched, "path", nil, "a file the task touches (repeatable)")
	cmd.Flags().StringVar(&text, "text", "", "the task text")
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		files, err := filepath.Glob(filepath.Join(args[0], "*", "pack.yaml"))
		if err != nil {
			return err
		}
		var all []Manifest
		for _, f := range files {
			m, err := LoadManifest(f, "")
			if err != nil {
				return err
			}
			all = append(all, *m)
		}
		for _, m := range Inject(all, touched, text) {
			if _, err := fmt.Fprintln(cmd.OutOrStdout(), m.Name); err != nil {
				return err
			}
		}
		return nil
	}
	return cmd
}
