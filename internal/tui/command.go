package tui

import (
	"context"
	"errors"

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
	return &cobra.Command{
		Use:   "board",
		Short: "Open the terminal board",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			ctl, ok := cmd.Context().Value(controlKey{}).(api.Control)
			if !ok || ctl == nil {
				return errors.New("board: no control attached to the command context")
			}
			p := tea.NewProgram(New(ctl),
				tea.WithContext(cmd.Context()),
				tea.WithInput(cmd.InOrStdin()),
				tea.WithOutput(cmd.OutOrStdout()))
			_, err := p.Run()
			return err
		},
	}
}
