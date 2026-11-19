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
	var co cmdOpts
	for _, f := range opts {
		f(&co)
	}
	var f runFlags
	c := &cobra.Command{
		Use:   "first-run",
		Short: "Audit this repo and show what the factory would fix, at no cost",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runFirstRun(cmd, &f, co)
		},
	}
	f.register(c, co.exec != nil)
	return c
}

// runFlags holds the parsed flag values of the first-run command.
type runFlags struct {
	opts               Options
	annPath, sarifPath string
	fix                bool
}

func (f *runFlags) register(c *cobra.Command, canFix bool) {
	c.Flags().BoolVar(&f.opts.DryRun, "dry-run", false, "stop after the report; say what would be dispatched")
	if canFix {
		c.Flags().BoolVar(&f.fix, "fix", false, "dispatch one build for the first covered finding and open a draft pull request")
	}
	c.Flags().StringVar(&f.opts.GH, "gh", "", "also audit this GitHub repo (owner/repo)")
	c.Flags().StringVar(&f.annPath, "annotations", defaultAnnotations, "reason-tagged suppressions file; the default is optional")
	c.Flags().StringVar(&f.sarifPath, "sarif", "", "also write the findings to this file as SARIF 2.1.0")
}

// runFirstRun audits, prints the report, writes SARIF if asked, and with --fix opens the draft PR.
func runFirstRun(cmd *cobra.Command, f *runFlags, co cmdOpts) error {
	ann, err := loadAnnotations(f.annPath, cmd.Flags().Changed("annotations"))
	if err != nil {
		return err
	}
	f.opts.Annotations = ann
	r, err := Run(cmd.Context(), f.opts)
	if err != nil {
		return err
	}
	md, err := r.Markdown()
	if err != nil {
		return err
	}
	if err := writeSARIF(r, f.sarifPath); err != nil {
		return err
	}
	if _, err = fmt.Fprint(cmd.OutOrStdout(), md); err != nil || !f.fix {
		return err
	}
	return runFix(cmd, r, co)
}

// writeSARIF writes the findings to path; an empty path writes nothing.
func writeSARIF(r Report, path string) error {
	if path == "" {
		return nil
	}
	js, err := r.SARIF("")
	if err != nil {
		return err
	}
	return os.WriteFile(path, js, 0o644)
}

// runFix dispatches the first fix and prints the plan, or the PR number and scorecard.
func runFix(cmd *cobra.Command, r Report, co cmdOpts) error {
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
