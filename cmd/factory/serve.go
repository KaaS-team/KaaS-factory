package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/serve"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// newServe is `factory serve`: the run loop plus /healthz, /readyz and /events on an address.
func newServe() *cobra.Command {
	var addr string
	var drain time.Duration
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run the factory loop as a service with /healthz, /readyz and /events",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			fs := pflag.NewFlagSet("serve", pflag.ContinueOnError)
			config.RegisterFlags(fs)
			l, err := loadConfig(fs)
			if err != nil {
				return err
			}
			c, err := newControl(l.Config)
			if err != nil {
				return err
			}
			core, ok := c.(serve.Core)
			if !ok {
				return fmt.Errorf("serve: this control does not own a run loop")
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt, syscall.SIGTERM)
			defer stop()
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "factory serve: listening on %s\n", addr)
			sched, err := scheduler(cmd.ErrOrStderr())
			if err != nil {
				return err
			}
			return serve.New(core, serve.Options{Interval: l.Config.PollInterval, Schedule: sched}).Serve(ctx, addr, drain)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address for /healthz, /readyz and /events")
	cmd.Flags().DurationVar(&drain, "drain", 30*time.Second, "how long to wait for the tick in flight on SIGTERM")
	return cmd
}

// scheduler is the default workflow's cron trigger, if it has one. Control has no call that starts a
// workflow yet, so a due tick is reported on w and remembered in .factory/state/schedules.json.
func scheduler(w io.Writer) (*serve.Scheduler, error) {
	g, err := graph.LoadDefault(".")
	if err != nil || g.On.Kind != graph.OnSchedule {
		return nil, nil // no default workflow, or one that is not scheduled
	}
	st, err := serve.OpenFileStore(".factory/state/schedules.json")
	if err != nil {
		return nil, err
	}
	host, _ := os.Hostname()
	sc := &serve.Scheduler{Schedules: []serve.Schedule{{Name: g.Name, Spec: g.On.Value}}, Store: st, Instance: host,
		Fire: func(_ context.Context, o serve.Occurrence) error {
			_, err := fmt.Fprintf(w, "factory serve: schedule %s due (tick %s, missed ticks dropped: %t)\n", o.Name, o.Nominal.Format(time.RFC3339), o.Skipped)
			return err
		}}
	return sc, sc.Validate()
}
