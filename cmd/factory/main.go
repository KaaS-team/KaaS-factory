// Command factory is the KaaS Factory CLI.
package main

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"time"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/a2a"
	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/browsercheck"
	"github.com/KaaS-team/factory/internal/dashboard"
	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/firstrun"
	"github.com/KaaS-team/factory/internal/initwiz"
	"github.com/KaaS-team/factory/internal/logs"
	"github.com/KaaS-team/factory/internal/mcp"
	"github.com/KaaS-team/factory/internal/packs"
	"github.com/KaaS-team/factory/internal/plancmd"
	"github.com/KaaS-team/factory/internal/report"
	"github.com/KaaS-team/factory/internal/store"
	"github.com/KaaS-team/factory/internal/tracker/github"
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
		st, err := openStore()
		if err != nil {
			return nil, err
		}
		return report.StoreSource{Store: st}, nil
	})))
	root.AddCommand(initwiz.NewCommand(), plancmd.NewCommand(
		plancmd.WithSpecFunc(plancmd.LocalSpec("claude", ".")),
		plancmd.WithEpic(func(ctx context.Context, n int) (string, error) {
			tr, err := planTracker()
			if err != nil {
				return "", err
			}
			return github.Epic(tr)(ctx, n)
		}),
		plancmd.WithFiler(lazyFiler{}),
	), eval.NewCommand(), packs.NewAddCommand(), packs.NewPacksCommand())
	root.AddCommand(logs.NewCommand(logBackends()), newServe(), a2a.NewCommand(a2aDeps), browsercheck.NewCommand())
}

// logBackends reads the session the run loop recorded for a ticket and its cloud run log.
// Local sessions have no run log file yet, so they are refused by name.
func logBackends() logs.Backends {
	cloud := func(s api.Session) (logs.Source, error) {
		tok := os.Getenv(envRoutinesToken)
		if tok == "" {
			return nil, fmt.Errorf("logs: env var %s is not set", envRoutinesToken)
		}
		return logs.RoutinesFactory(logs.NewHTTPRunLog(routinesURL(), tok, &http.Client{Timeout: 30 * time.Second}))(s)
	}
	return logs.Backends{
		Latest: func(ctx context.Context, id api.TicketID) (api.Session, error) {
			if _, err := os.Stat(dbPath); errors.Is(err, fs.ErrNotExist) {
				return api.Session{}, logs.ErrNoSession
			}
			st, err := store.Open(dbPath)
			if err != nil {
				return api.Session{}, err
			}
			defer func() { _ = st.Close() }()
			return st.LatestSession(ctx, id)
		},
		Factories: map[string]func(api.Session) (logs.Source, error){"routines": cloud, "fire": cloud},
	}
}

// planTracker builds the GitHub tracker `factory plan` files tickets into and reads epics from.
func planTracker() (*github.Tracker, error) {
	l, err := loadConfig(nil)
	if err != nil {
		return nil, err
	}
	if l.Config.Tracker != "github" {
		return nil, fmt.Errorf("plan: filing tickets and reading epics needs tracker github, not %q", l.Config.Tracker)
	}
	g, err := newGitHubConn(l.Config)
	if err != nil {
		return nil, err
	}
	return g.tracker()
}

// lazyFiler builds the tracker on first use, so `factory plan` without --approve needs no token.
type lazyFiler struct{}

func (lazyFiler) Find(ctx context.Context, title string) (api.TicketID, bool, error) {
	tr, err := planTracker()
	if err != nil {
		return "", false, err
	}
	return tr.Find(ctx, title)
}

func (lazyFiler) Create(ctx context.Context, t api.Ticket) (api.TicketID, error) {
	tr, err := planTracker()
	if err != nil {
		return "", err
	}
	return tr.Create(ctx, t)
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
