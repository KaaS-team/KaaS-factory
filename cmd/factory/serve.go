package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/KaaS-team/factory/internal/config"
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
			return serve.New(core, serve.Options{Interval: l.Config.PollInterval}).Serve(ctx, addr, drain)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address for /healthz, /readyz and /events")
	cmd.Flags().DurationVar(&drain, "drain", 30*time.Second, "how long to wait for the tick in flight on SIGTERM")
	return cmd
}
