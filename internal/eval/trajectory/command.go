package trajectory

import (
	"fmt"

	"github.com/spf13/cobra"
)

// NewStatsCommand returns `stats <dir-or-file>`: statistics over trajectory files, no model needed.
func NewStatsCommand() *cobra.Command {
	return &cobra.Command{
		Use:           "stats <trajectories>",
		Short:         "Summarise trajectory files offline",
		Args:          cobra.ExactArgs(1),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			ts, err := Load(args[0])
			if err != nil {
				return err
			}
			_, err = fmt.Fprint(cmd.OutOrStdout(), Summarize(ts).Markdown())
			return err
		},
	}
}

// NewCompareCommand returns `compare <old> <new>`: two runs paired by task name, no model needed.
func NewCompareCommand() *cobra.Command {
	return &cobra.Command{
		Use:           "compare <old> <new>",
		Short:         "Compare two sets of trajectory files offline",
		Args:          cobra.ExactArgs(2),
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, args []string) error {
			o, err := Load(args[0])
			if err != nil {
				return err
			}
			n, err := Load(args[1])
			if err != nil {
				return err
			}
			_, err = fmt.Fprint(cmd.OutOrStdout(), Compare(o, n).Markdown())
			return err
		},
	}
}
