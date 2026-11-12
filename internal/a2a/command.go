package a2a

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"time"

	"github.com/spf13/cobra"
)

// TokenEnv names the environment variable that holds the bearer token.
const TokenEnv = "FACTORY_A2A_TOKEN"

// ErrNoToken is returned when the server is asked to start without a bearer token.
var ErrNoToken = errors.New("a2a: " + TokenEnv + " is not set; refusing to start")

// DepsFunc builds the server's dependencies once the token check has passed.
type DepsFunc func(ctx context.Context) (Deps, error)

// NewCommand returns `factory a2a --addr`, which serves the handler until interrupted.
// It reads the token from FACTORY_A2A_TOKEN and refuses to start without one.
func NewCommand(open DepsFunc) *cobra.Command {
	var addr string
	cmd := &cobra.Command{
		Use:   "a2a",
		Short: "Serve the factory as an A2A agent",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			token := os.Getenv(TokenEnv)
			if token == "" {
				return ErrNoToken
			}
			ctx, stop := signal.NotifyContext(cmd.Context(), os.Interrupt)
			defer stop()
			deps, err := open(ctx)
			if err != nil {
				return err
			}
			deps.Token = token
			srv := &http.Server{Addr: addr, Handler: NewHandler(deps), ReadHeaderTimeout: 10 * time.Second}
			go func() {
				<-ctx.Done()
				sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				_ = srv.Shutdown(sctx)
			}()
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "factory a2a listening on %s\n", addr)
			if err := srv.ListenAndServe(); !errors.Is(err, http.ErrServerClosed) {
				return err
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8787", "listen address")
	return cmd
}
