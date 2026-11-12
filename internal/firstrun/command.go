package firstrun

import (
	"fmt"

	"github.com/spf13/cobra"
)

// NewCommand returns `factory first-run [--dry-run] [--gh owner/repo]`.
func NewCommand() *cobra.Command {
	var o Options
	c := &cobra.Command{
		Use:   "first-run",
		Short: "Audit this repo and show what the factory would fix, at no cost",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			r, err := Run(cmd.Context(), o)
			if err != nil {
				return err
			}
			md, err := r.Markdown()
			if err != nil {
				return err
			}
			_, err = fmt.Fprint(cmd.OutOrStdout(), md)
			return err
		},
	}
	c.Flags().BoolVar(&o.DryRun, "dry-run", false, "stop after the report; name no first fix")
	c.Flags().StringVar(&o.GH, "gh", "", "also audit this GitHub repo (owner/repo)")
	return c
}
