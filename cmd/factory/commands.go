package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// addCommands adds the daily operator commands to root.
func addCommands(root *cobra.Command) {
	root.AddCommand(statusCmd(), runCmd(), queueCmd(), configCmd(), doctorCmd())
	for _, a := range []struct {
		name, short string
		call        func(context.Context, api.Control, api.TicketID) error
	}{
		{"dispatch", "Start a session for a ticket now", func(ctx context.Context, c api.Control, id api.TicketID) error { return c.Dispatch(ctx, id) }},
		{"cancel", "Cancel a ticket's running session", func(ctx context.Context, c api.Control, id api.TicketID) error { return c.Cancel(ctx, id) }},
		{"retry", "Queue a new attempt for a ticket", func(ctx context.Context, c api.Control, id api.TicketID) error { return c.Retry(ctx, id) }},
	} {
		root.AddCommand(ticketCmd(a.name, a.short, a.call))
	}
	root.AddCommand(steerCmd(), reviewCmd())
}

// control loads the config and builds the Control through the newControl seam.
func control(fs *pflag.FlagSet) (api.Control, error) {
	l, err := loadConfig(fs)
	if err != nil {
		return nil, err
	}
	return newControl(l.Config)
}

func ticketCmd(name, short string, call func(context.Context, api.Control, api.TicketID) error) *cobra.Command {
	return &cobra.Command{
		Use:   name + " <ticket>",
		Short: short,
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := control(nil)
			if err != nil {
				return err
			}
			if err := call(cmd.Context(), c, api.TicketID(args[0])); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s %s\n", name, args[0])
			return nil
		},
	}
}

func steerCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "steer <ticket> [message...]",
		Short: "Send a message to a ticket's running session",
		Args:  cobra.MinimumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			c, err := control(nil)
			if err != nil {
				return err
			}
			if err := c.Steer(cmd.Context(), api.TicketID(args[0]), strings.Join(args[1:], " ")); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "steer %s\n", args[0])
			return nil
		},
	}
}

func statusCmd() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show the board, one row per slot",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := control(nil)
			if err != nil {
				return err
			}
			b, err := c.Board(cmd.Context())
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			if asJSON {
				return json.NewEncoder(out).Encode(b)
			}
			for _, s := range b.Slots {
				_, _ = fmt.Fprintf(out, "%s\t%s\t%s\n", s.Ticket.ID, s.Phase, s.Ticket.Title)
			}
			return nil
		},
	}
	cmd.Flags().BoolVar(&asJSON, "json", false, "print the board as one JSON object")
	return cmd
}

func queueCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "queue",
		Short: "Show tickets ready to run and the merge queue",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			c, err := control(nil)
			if err != nil {
				return err
			}
			b, err := c.Board(cmd.Context())
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			for _, t := range b.Ready {
				_, _ = fmt.Fprintf(out, "ready\t%s\t%s\n", t.ID, t.Title)
			}
			for _, id := range b.MergeQueue {
				_, _ = fmt.Fprintf(out, "merge-queue\t%s\n", id)
			}
			return nil
		},
	}
}

func runCmd() *cobra.Command {
	var headless bool
	var slots int
	cmd := &cobra.Command{
		Use:   "run",
		Short: "Run the factory; --headless streams one JSON event per line",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			fs := pflag.NewFlagSet("run", pflag.ContinueOnError)
			config.RegisterFlags(fs)
			if cmd.Flags().Changed("slots") {
				if err := fs.Set("slots", fmt.Sprint(slots)); err != nil {
					return err
				}
			}
			c, err := control(fs)
			if err != nil {
				return err
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			ev, err := c.Events(ctx)
			if err != nil {
				return err
			}
			// A Control that owns a loop (core.Core) is started here; the loop ends with ctx.
			if l, ok := c.(interface{ Run(context.Context) error }); ok {
				loopDone := make(chan struct{})
				go func() { defer close(loopDone); _ = l.Run(ctx) }()
				defer func() { stop(); <-loopDone }()
			}
			out, logs := cmd.OutOrStdout(), cmd.ErrOrStderr()
			if !headless {
				_, _ = fmt.Fprintln(logs, "factory run: streaming events (use --headless for NDJSON on stdout)")
			}
			enc := json.NewEncoder(out)
			for {
				select {
				case <-ctx.Done():
					return nil
				case e, ok := <-ev:
					if !ok {
						return nil
					}
					if headless {
						if err := enc.Encode(e); err != nil {
							return err
						}
						continue
					}
					_, _ = fmt.Fprintf(out, "%s\t%s\t%s\n", e.Time.Format("15:04:05"), e.Kind, e.Ticket)
				}
			}
		},
	}
	cmd.Flags().BoolVar(&headless, "headless", false, "print one api.Event JSON object per line and nothing else on stdout")
	cmd.Flags().IntVar(&slots, "slots", 0, "number of parallel slots (overrides config)")
	return cmd
}

func configCmd() *cobra.Command {
	cfg := &cobra.Command{Use: "config", Short: "Read resolved configuration"}
	cfg.AddCommand(&cobra.Command{
		Use:   "get <key>",
		Short: "Print the resolved value of a key",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			l, err := loadConfig(nil)
			if err != nil {
				return err
			}
			v, ok := l.Config.Get(args[0])
			if !ok {
				return fmt.Errorf("unknown key %q", args[0])
			}
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), v)
			return nil
		},
	}, &cobra.Command{
		Use:   "explain <key>",
		Short: "Print which layer set a key and which layers it overrode",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			l, err := loadConfig(nil)
			if err != nil {
				return err
			}
			ex, err := l.Explain(args[0])
			if err != nil {
				return err
			}
			out := cmd.OutOrStdout()
			_, _ = fmt.Fprintln(out, ex)
			for _, a := range ex.Tried {
				src := a.Source
				if src == "" {
					src = "-"
				}
				_, _ = fmt.Fprintf(out, "  %s\t%v\t%s\n", a.Layer, a.Value, src)
			}
			return nil
		},
	})
	return cfg
}
