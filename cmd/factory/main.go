// Command factory is the KaaS Factory CLI.
package main

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// version is set at release time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "factory",
		Short:         "Plan work into tickets and run them on parallel coding-agent sessions",
		SilenceUsage:  true,
		SilenceErrors: true,
	}
	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the factory version",
		Run: func(cmd *cobra.Command, _ []string) {
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), version)
		},
	})
	return root
}

func main() {
	if err := newRoot().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "factory:", err)
		os.Exit(1)
	}
}
