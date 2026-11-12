package main

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/docgen"
)

// docsCmd is `factory docs cli|config`: it prints the generated reference documents, the same text
// docs/cli-reference.md and docs/config.md hold, so a release can regenerate them from the binary.
func docsCmd(root func() *cobra.Command) *cobra.Command {
	c := &cobra.Command{Use: "docs", Short: "Print a generated reference document", Hidden: true}
	c.AddCommand(&cobra.Command{
		Use:   "cli",
		Short: "Print the CLI reference from the command tree",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, err := fmt.Fprint(cmd.OutOrStdout(), docgen.CLI(root()))
			return err
		},
	}, &cobra.Command{
		Use:   "config",
		Short: "Print the config reference from internal/config",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			_, err := fmt.Fprint(cmd.OutOrStdout(), docgen.Config())
			return err
		},
	})
	return c
}
