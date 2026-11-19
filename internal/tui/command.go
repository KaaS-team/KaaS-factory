package tui

import (
	"context"
	"errors"
	"fmt"
	"os"

	tea "charm.land/bubbletea/v2"
	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/api"
)

type controlKey struct{}

// WithControl returns a context carrying the Control the board command talks to.
func WithControl(ctx context.Context, ctl api.Control) context.Context {
	return context.WithValue(ctx, controlKey{}, ctl)
}

// NewCommand returns the `board` command. The caller attaches a Control with WithControl on the
// command's context before executing it.
func NewCommand() *cobra.Command {
	var (
		replay   string
		speed    float64
		operator bool
	)
	c := &cobra.Command{
		Use:   "board",
		Short: "Open the terminal board",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			var ctl api.Control
			opts := []Option{WithOperator(operator)}
			if replay != "" {
				f, err := os.Open(replay)
				if err != nil {
					return fmt.Errorf("board: %w", err)
				}
				defer func() { _ = f.Close() }()
				rp, err := NewReplay(f, speed)
				if err != nil {
					return fmt.Errorf("board: read %s: %w", replay, err)
				}
				ctl = rp
				opts = append(opts, WithClock(rp.Now))
			} else {
				var ok bool
				ctl, ok = cmd.Context().Value(controlKey{}).(api.Control)
				if !ok || ctl == nil {
					return errors.New("board: no control attached to the command context")
				}
			}
			p := tea.NewProgram(New(ctl, opts...),
				tea.WithContext(cmd.Context()),
				tea.WithInput(cmd.InOrStdin()),
				tea.WithOutput(cmd.OutOrStdout()))
			_, err := p.Run()
			return err
		},
	}
	c.Flags().StringVar(&replay, "replay", "", "play a recorded headless event stream (NDJSON) instead of a live fleet")
	c.Flags().Float64Var(&speed, "speed", 1, "replay speed: 10 plays ten times faster than recorded")
	c.Flags().BoolVar(&operator, "operator", false, "show tokens against budget on each card")
	return c
}
