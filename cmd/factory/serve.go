package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/serve"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// servePasswordEnv names the bearer password for `factory serve`. Without it the listener must be
// loopback; with it every route but /healthz and /readyz needs the password or a token from
// `factory serve token`.
const servePasswordEnv = "KAAS_SERVE_PASSWORD" // not FACTORY_*: that prefix is reserved for config keys

// serveAuth returns the address to listen on and the middleware that guards the routes.
func serveAuth(addr string) (string, func(http.Handler) http.Handler, error) {
	pw := os.Getenv(servePasswordEnv)
	if pw == "" {
		a, err := local.LoopbackAddr(addr)
		if err != nil {
			return "", nil, fmt.Errorf("serve: %w; set %s to listen elsewhere", err, servePasswordEnv)
		}
		return a, nil, nil
	}
	auth, err := local.NewAuth(pw)
	if err != nil {
		return "", nil, err
	}
	return addr, func(next http.Handler) http.Handler {
		guarded := auth.Middleware(next)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/healthz" || r.URL.Path == "/readyz" {
				next.ServeHTTP(w, r)
				return
			}
			guarded.ServeHTTP(w, r)
		})
	}, nil
}

// serveTokenCmd is `factory serve token`: a 30 day session token, so a client need not hold the password.
func serveTokenCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "token",
		Short: "Print a session token for the serve listener, signed from " + servePasswordEnv,
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			a, err := local.NewAuth(os.Getenv(servePasswordEnv))
			if err != nil {
				return fmt.Errorf("serve token: set %s: %w", servePasswordEnv, err)
			}
			_, err = fmt.Fprintln(cmd.OutOrStdout(), a.Issue())
			return err
		},
	}
}

// newServe is `factory serve`: the run loop plus /healthz, /readyz and /events on an address.
func newServe() *cobra.Command {
	var addr string
	var drain time.Duration
	cmd := &cobra.Command{
		Use:   "serve",
		Short: "Run the factory loop as a service with /healthz, /readyz and /events",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			listen, wrap, err := serveAuth(addr)
			if err != nil {
				return err
			}
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
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "factory serve: listening on %s\n", listen)
			return serve.New(core, serve.Options{Interval: l.Config.PollInterval, Wrap: wrap}).Serve(ctx, listen, drain)
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "address for /healthz, /readyz and /events")
	cmd.AddCommand(serveTokenCmd())
	cmd.Flags().DurationVar(&drain, "drain", 30*time.Second, "how long to wait for the tick in flight on SIGTERM")
	return cmd
}
