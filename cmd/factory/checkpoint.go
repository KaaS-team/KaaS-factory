package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/gitx/checkpoint"
)

// scratchDir holds the per-session scratch index the worktree checkpoints reuse between snapshots.
const scratchDir = ".factory/cache/checkpoints"

// checkpointCmd is `factory checkpoint`: snapshot the worktree before an agent session touches it,
// see what the session changed, put the tree back, and clear the snapshots afterwards.
func checkpointCmd() *cobra.Command {
	root := &cobra.Command{Use: "checkpoint", Short: "Snapshot and restore the worktree around an agent session"}
	root.AddCommand(
		checkpointSaveCmd(), checkpointDiffCmd(), checkpointRestoreCmd(),
		checkpointDropCmd(), checkpointReapCmd(),
	)
	return root
}

// checkpointStore opens the snapshot store of one session under the current directory.
func checkpointStore(session string) (*checkpoint.Store, error) {
	repo, err := os.Getwd()
	if err != nil {
		return nil, err
	}
	return checkpoint.New(repo, filepath.Join(repo, scratchDir), session)
}

// checkpointRunCmd is a subcommand over one numbered snapshot of a session.
func checkpointRunCmd(use, short string, run func(cmd *cobra.Command, s *checkpoint.Store, n int) error) *cobra.Command {
	return &cobra.Command{
		Use: use + " <session> <run>", Short: short, Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			n, err := strconv.Atoi(args[1])
			if err != nil || n < 0 {
				return fmt.Errorf("checkpoint: run must be a whole number, got %q", args[1])
			}
			s, err := checkpointStore(args[0])
			if err != nil {
				return err
			}
			return run(cmd, s, n)
		},
	}
}

func checkpointSaveCmd() *cobra.Command {
	return checkpointRunCmd("save", "Snapshot tracked, staged and untracked files as run N", func(cmd *cobra.Command, s *checkpoint.Store, n int) error {
		e, err := s.Snapshot(cmd.Context(), n)
		if err == nil {
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "saved %d %s\n", e.Run, e.Ref)
		}
		return err
	})
}

func checkpointDiffCmd() *cobra.Command {
	return checkpointRunCmd("diff", "List the paths that differ between run N and the worktree now", func(cmd *cobra.Command, s *checkpoint.Store, n int) error {
		cs, err := s.Diff(cmd.Context(), n)
		for _, c := range cs {
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s\t%s\n", c.Status, c.Path)
		}
		return err
	})
}

func checkpointRestoreCmd() *cobra.Command {
	return checkpointRunCmd("restore", "Put the worktree back as run N saved it", func(cmd *cobra.Command, s *checkpoint.Store, n int) error {
		err := s.Restore(cmd.Context(), n)
		if err == nil {
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "restored %d\n", n)
		}
		return err
	})
}

func checkpointDropCmd() *cobra.Command {
	return &cobra.Command{
		Use: "drop <session>", Short: "Delete a session's snapshots", Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			s, err := checkpointStore(args[0])
			if err == nil {
				err = s.Delete(cmd.Context())
			}
			if err == nil {
				_, _ = fmt.Fprintf(cmd.OutOrStdout(), "dropped %s\n", args[0])
			}
			return err
		},
	}
}

func checkpointReapCmd() *cobra.Command {
	return &cobra.Command{
		Use: "reap", Short: "Delete snapshots and scratch dirs left by sessions that never ended", Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			repo, err := os.Getwd()
			if err == nil {
				err = checkpoint.Reap(cmd.Context(), repo, filepath.Join(repo, scratchDir), time.Now())
			}
			if err == nil {
				_, _ = fmt.Fprintln(cmd.OutOrStdout(), "reaped")
			}
			return err
		},
	}
}
