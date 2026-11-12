package logs

import (
	"context"
	"errors"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/api"
)

// Resolver finds the run-log Source of a ticket's latest attempt. The
// supervisor builds it over its dispatchers.
type Resolver interface {
	Source(ctx context.Context, id api.TicketID) (Source, error)
}

// ErrNoSession is what a Resolver returns when the ticket has no session.
var ErrNoSession = errors.New("logs: ticket has no session")

// SessionLookup finds a ticket's newest session.
type SessionLookup func(ctx context.Context, id api.TicketID) (api.Session, error)

// Backends is a Resolver over a SessionLookup: it picks the Source factory
// named by the session's Dispatcher ("routines" or "local").
type Backends struct {
	Latest    SessionLookup
	Factories map[string]func(api.Session) (Source, error)
}

// Source returns the run-log Source for the ticket's latest session.
func (b Backends) Source(ctx context.Context, id api.TicketID) (Source, error) {
	s, err := b.Latest(ctx, id)
	if err != nil {
		return nil, err
	}
	f, ok := b.Factories[s.Dispatcher]
	if !ok {
		return nil, fmt.Errorf("logs: no run log for dispatcher %q", s.Dispatcher)
	}
	return f(s)
}

// NewCommand returns the `logs <ticket>` command with --follow and --json.
func NewCommand(r Resolver) *cobra.Command {
	var o Options
	cmd := &cobra.Command{
		Use:   "logs <ticket>",
		Short: "Print what a ticket's session is doing",
		Args:  cobra.ExactArgs(1),
		RunE: func(c *cobra.Command, args []string) error {
			src, err := r.Source(c.Context(), api.TicketID(args[0]))
			if err != nil {
				return err
			}
			err = Print(c.Context(), c.OutOrStdout(), src, o)
			if errors.Is(err, context.Canceled) {
				return nil
			}
			return err
		},
	}
	cmd.Flags().BoolVarP(&o.Follow, "follow", "f", false, "keep polling until the session ends")
	cmd.Flags().DurationVar(&o.Interval, "interval", DefaultInterval, "poll interval for --follow")
	cmd.Flags().BoolVar(&o.JSON, "json", false, "print one JSON event per line")
	return cmd
}
