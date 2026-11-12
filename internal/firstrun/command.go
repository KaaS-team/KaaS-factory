package firstrun

import (
	"fmt"

	"github.com/spf13/cobra"
)

// Option configures NewCommand.
type Option func(*cmdOpts)

type cmdOpts struct{ exec *Exec }

// WithExec lets the command dispatch the first fix and open its draft pull request; without it the command only reports.
func WithExec(e Exec) Option { return func(o *cmdOpts) { o.exec = &e } }

// NewCommand returns `factory first-run [--dry-run] [--gh owner/repo]`.
func NewCommand(opts ...Option) *cobra.Command {
	var o Options
	var co cmdOpts
	for _, f := range opts {
		f(&co)
	}
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
			if _, err = fmt.Fprint(cmd.OutOrStdout(), md); err != nil || co.exec == nil {
				return err
			}
			res, err := Execute(cmd.Context(), r, *co.exec)
			if err != nil {
				return err
			}
			if res.Plan != "" {
				_, err = fmt.Fprintln(cmd.OutOrStdout(), res.Plan)
				return err
			}
			js, err := res.Scorecard.JSON()
			if err != nil {
				return err
			}
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "\nDraft pull request #%d opened.\n\n%s\n", res.PR, js)
			return err
		},
	}
	c.Flags().BoolVar(&o.DryRun, "dry-run", false, "stop after the report; say what would be dispatched")
	c.Flags().StringVar(&o.GH, "gh", "", "also audit this GitHub repo (owner/repo)")
	return c
}
