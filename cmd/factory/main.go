// Command factory is the KaaS Factory CLI. It builds the cobra command tree: the board and run
// commands over the api.Control contract, plus the plan, pack, eval, audit, MCP and design
// commands mounted from internal packages. People and CI call it as `factory <command>`, and the
// pack and workflow files run it as a subprocess. Each command lives in its own file here and stays
// a thin parse, call and render layer over internal code.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/a2a"
	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/audit"
	"github.com/KaaS-team/factory/internal/browsercheck"
	"github.com/KaaS-team/factory/internal/dashboard"
	"github.com/KaaS-team/factory/internal/dispatch/shadow"
	"github.com/KaaS-team/factory/internal/eval"
	"github.com/KaaS-team/factory/internal/firstrun"
	"github.com/KaaS-team/factory/internal/initwiz"
	"github.com/KaaS-team/factory/internal/logs"
	"github.com/KaaS-team/factory/internal/mcp"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/packs"
	"github.com/KaaS-team/factory/internal/packs/repomap"
	"github.com/KaaS-team/factory/internal/plancmd"
	"github.com/KaaS-team/factory/internal/report"
	"github.com/KaaS-team/factory/internal/selfupdate"
	"github.com/KaaS-team/factory/internal/store"
	"github.com/KaaS-team/factory/internal/tracker/github"
	"github.com/KaaS-team/factory/internal/tui"
	"github.com/KaaS-team/factory/internal/upgrade"
	"github.com/KaaS-team/factory/pkg/sandbox"
)

// version is set at release time with -ldflags "-X main.version=...".
var version = "0.0.0-dev"

// commit and date are set the same way (-X main.commit, -X main.date).
var commit, date = "none", "unknown"

func newRoot() *cobra.Command {
	root := &cobra.Command{
		Use:           "factory",
		Short:         "Plan work into tickets and run them on parallel coding-agent sessions",
		SilenceUsage:  true,
		SilenceErrors: true,
		Version:       fmt.Sprintf("%s (commit %s, built %s)", version, commit, date),
	}
	root.SetVersionTemplate("factory {{.Version}}\n")
	root.AddCommand(&cobra.Command{
		Use:   "version",
		Short: "Print the factory version",
		Run: func(cmd *cobra.Command, _ []string) {
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), version)
		},
	})
	addCommands(root)
	addEE(root)
	mountClients(root)
	root.AddCommand(docsCmd(newRoot), designCmd())
	return root
}

// mountClients mounts the commands from the client packages. Those that need a Control build it
// lazily in a PersistentPreRunE, so version, doctor and config never construct one.
func mountClients(root *cobra.Command) {
	board := tui.NewCommand()
	attach(board, tui.WithControl)
	dash := dashboard.NewCommand()
	attach(dash, dashboard.WithControl)
	root.AddCommand(board, dash, firstrun.NewCommand(firstrun.WithExec(firstRunExec)), upgrade.NewSelfCommand(version, selfupdate.GitHubSource{}, ""))
	root.AddCommand(mcp.NewCommand(mcp.WithControl(func() (api.Control, mcp.Handlers, error) {
		c, err := control(nil)
		return c, mcpHandlers(), err
	})))
	root.AddCommand(report.NewCommand(report.WithSource(func(context.Context) (report.Source, error) {
		st, err := openStore()
		if err != nil {
			return nil, err
		}
		src := report.StoreSource{Store: st}
		if tr, err := planTracker(); err == nil {
			src.Ledger = meter.Ledger{Thread: tr}
		}
		return src, nil
	})))
	root.AddCommand(initwiz.NewCommand(), plancmd.NewCommand(
		plancmd.WithSpecFunc(plancmd.LocalSpec("claude", ".")),
		plancmd.WithSpecFactory(func(dir string) plancmd.SpecFunc { return plancmd.LocalSpec("claude", dir) }),
		plancmd.WithEpic(func(ctx context.Context, n int) (string, error) {
			tr, err := planTracker()
			if err != nil {
				return "", err
			}
			return github.Epic(tr)(ctx, n)
		}),
		plancmd.WithFiler(lazyFiler{}),
	), eval.NewCommand(), shadow.NewCommand(), packs.NewAddCommand(), packsCommand(), repomap.NewCommand())
	root.AddCommand(audit.NewCommand(), logs.NewCommand(logBackends()), newServe(), a2a.NewCommand(a2aDeps), browsercheck.NewCommand())
}

// packsCommand is `factory packs`, with `packs upgrade` bumping pinned packs.
func packsCommand() *cobra.Command {
	c := packs.NewPacksCommand()
	c.AddCommand(upgrade.NewCommand())
	return c
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

// mcpHandlers backs the MCP tools that have a CLI command with that command, run in process, so a
// tool and its command share one code path. The CLI keeps no plan id between calls, so approve_plan
// takes the goal and runs `plan --approve` in one call.
func mcpHandlers() mcp.Handlers {
	return mcp.Handlers{
		FirstRun: func(ctx context.Context) (string, error) { return runSub(ctx, "first-run", "--dry-run") },
		Report:   func(ctx context.Context) (string, error) { return runSub(ctx, "report") },
		Plan: func(ctx context.Context, in mcp.PlanInput) (string, error) {
			return dataSub(ctx, "plan", in.Goal, "plan", "goal must be text")
		},
		ApprovePlan: func(ctx context.Context, in mcp.ApprovePlanInput) (string, error) {
			return dataSub(ctx, "approve_plan", in.Goal, "plan", "goal must be text", "--approve")
		},
		ExplainConfig: func(ctx context.Context, in mcp.ExplainConfigInput) (string, error) {
			return dataSub(ctx, "explain_config", in.Key, "config", "key must be a name", "explain")
		},
	}
}

// dataSub runs `factory <cmd> <args> -- <value>`. The value is data: empty or starting with "-" is
// refused, so a client can never turn it into a flag.
func dataSub(ctx context.Context, tool, value, cmd, want string, args ...string) (string, error) {
	if v := strings.TrimSpace(value); v == "" || strings.HasPrefix(v, "-") {
		return "", fmt.Errorf("%s: %s, not empty or a flag", tool, want)
	}
	return runSub(ctx, append(append([]string{cmd}, args...), "--", value)...)
}

// runSub runs one factory subcommand and returns what it printed.
func runSub(ctx context.Context, args ...string) (string, error) {
	var out bytes.Buffer
	root := newRoot()
	root.SetOut(&out)
	root.SetErr(&out)
	root.SetIn(strings.NewReader(""))
	root.SetArgs(args)
	err := root.ExecuteContext(ctx)
	return out.String(), err
}

// attach builds the Control when cmd runs and hands it to the package through with.
func attach(cmd *cobra.Command, with func(context.Context, api.Control) context.Context) {
	cmd.PersistentPreRunE = func(c *cobra.Command, _ []string) error {
		// A replay plays a recorded file, so it needs no tracker or live fleet.
		if f := c.Flags().Lookup("replay"); f != nil && f.Value.String() != "" {
			return nil
		}
		ctl, err := control(nil)
		if err != nil {
			return err
		}
		c.SetContext(with(c.Context(), ctl))
		return nil
	}
}

func main() {
	if err := sandbox.MaybeEnter(); err != nil {
		fmt.Fprintln(os.Stderr, "factory:", err)
		os.Exit(1)
	}
	flush := audit.Install(context.Background())
	err := newRoot().Execute()
	flush()
	if err != nil {
		fmt.Fprintln(os.Stderr, "factory:", err)
		var ec interface{ ExitCode() int }
		if errors.As(err, &ec) {
			os.Exit(ec.ExitCode())
		}
		os.Exit(1)
	}
}
