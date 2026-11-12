// Command factory is the KaaS Factory CLI.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/dashboard"
	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/firstrun"
	"github.com/KaaS-team/factory/internal/initwiz"
	"github.com/KaaS-team/factory/internal/logs"
	"github.com/KaaS-team/factory/internal/mcp"
	"github.com/KaaS-team/factory/internal/packs"
	"github.com/KaaS-team/factory/internal/plancmd"
	"github.com/KaaS-team/factory/internal/report"
	"github.com/KaaS-team/factory/internal/tui"
	"github.com/KaaS-team/factory/internal/upgrade"
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
	addCommands(root)
	mountClients(root)
	return root
}

// mountClients mounts the commands from the client packages. Those that need a Control build it
// lazily in a PersistentPreRunE, so version, doctor and config never construct one.
func mountClients(root *cobra.Command) {
	board := tui.NewCommand()
	attach(board, tui.WithControl)
	dash := dashboard.NewCommand()
	attach(dash, dashboard.WithControl)
	root.AddCommand(board, dash, firstrun.NewCommand(), upgrade.NewCommand())
	root.AddCommand(mcp.NewCommand(mcp.WithControl(func() (api.Control, mcp.Handlers, error) {
		c, err := control(nil)
		return c, mcp.Handlers{}, err
	})))
	root.AddCommand(report.NewCommand(report.WithSource(func(context.Context) (report.Source, error) {
		return nil, errors.New("report: no ticket source is wired in this build")
	})))
	// plan prints the DAG with no filer; --approve fails until a tracker that can file issues is wired.
	root.AddCommand(initwiz.NewCommand(), plancmd.NewCommand(), eval.NewCommand(),
		packs.NewAddCommand(), packs.NewPacksCommand())
	root.AddCommand(logs.NewCommand(logs.Backends{Latest: func(context.Context, api.TicketID) (api.Session, error) {
		return api.Session{}, errors.New("logs: no session lookup is wired in this build")
	}}))
}

// attach builds the Control when cmd runs and hands it to the package through with.
func attach(cmd *cobra.Command, with func(context.Context, api.Control) context.Context) {
	cmd.PersistentPreRunE = func(c *cobra.Command, _ []string) error {
		ctl, err := control(nil)
		if err != nil {
			return err
		}
		c.SetContext(with(c.Context(), ctl))
		return nil
	}
}

func main() {
	if err := newRoot().Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "factory:", err)
		os.Exit(1)
	}
}
