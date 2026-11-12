package firstrun

import (
	"context"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/firstrun/sarif"
)

// Option configures NewCommand.
type Option func(*cmdOpts)

type cmdOpts struct {
	exec func(context.Context) (Exec, error)
}

// WithExec lets `--fix` dispatch the first fix and open its draft pull request. f builds the Exec
// only when --fix runs, so a plain report needs no token. Without it the command only reports.
func WithExec(f func(context.Context) (Exec, error)) Option { return func(o *cmdOpts) { o.exec = f } }

// NewCommand returns `factory first-run [--dry-run] [--gh owner/repo]`.
func NewCommand(opts ...Option) *cobra.Command {
	var o Options
	var annPath, sarifPath string
	var fix bool
	var co cmdOpts
	for _, f := range opts {
		f(&co)
	}
	c := &cobra.Command{
		Use:   "first-run",
		Short: "Audit this repo and show what the factory would fix, at no cost",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ann, err := loadAnnotations(annPath, cmd.Flags().Changed("annotations"))
			if err != nil {
				return err
			}
			o.Annotations = ann
			r, err := Run(cmd.Context(), o)
			if err != nil {
				return err
			}
			md, err := r.Markdown()
			if err != nil {
				return err
			}
			if sarifPath != "" {
				js, err := r.SARIF("")
				if err != nil {
					return err
				}
				if err := os.WriteFile(sarifPath, js, 0o644); err != nil {
					return err
				}
			}
			if _, err = fmt.Fprint(cmd.OutOrStdout(), md); err != nil || !fix {
				return err
			}
			e, err := co.exec(cmd.Context())
			if err != nil {
				return err
			}
			res, err := Execute(cmd.Context(), r, e)
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
	if co.exec != nil {
		c.Flags().BoolVar(&fix, "fix", false, "dispatch one build for the first covered finding and open a draft pull request")
	}
	c.Flags().StringVar(&o.GH, "gh", "", "also audit this GitHub repo (owner/repo)")
	c.Flags().StringVar(&annPath, "annotations", defaultAnnotations, "reason-tagged suppressions file; the default is optional")
	c.Flags().StringVar(&sarifPath, "sarif", "", "also write the findings to this file as SARIF 2.1.0")
	return c
}

const defaultAnnotations = ".factory/annotations.yml"

// loadAnnotations reads the annotations file. A missing file is an error only when the user named it.
func loadAnnotations(path string, explicit bool) (sarif.Config, error) {
	f, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) && !explicit {
			return sarif.Config{}, nil
		}
		return sarif.Config{}, err
	}
	defer func() { _ = f.Close() }()
	return sarif.ParseAnnotations(f)
}
