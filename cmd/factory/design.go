package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/design"
)

// errNeedsAgent is what `factory design tweak` returns when the pack cannot make the edit: no agent
// runs here, so the command fails and a workflow check step routes to its agent step.
var errNeedsAgent = errors.New("design: the edit needs an agent")

// designCmd is `factory design`: the deterministic design edits of packs/design, with no agent.
func designCmd() *cobra.Command {
	var pack string
	var jail bool
	c := &cobra.Command{Use: "design", Short: "Make design edits to a JSX tree without a coding agent"}
	c.PersistentFlags().StringVar(&pack, "pack", "packs/design", "directory of the design pack")
	c.PersistentFlags().BoolVar(&jail, "jail", false, "run the pack under the sandbox with no network and only the tree writable")
	// The runner starts node inside the tree, so a relative pack path is made absolute first.
	runner := func() design.Runner {
		abs, err := filepath.Abs(pack)
		if err != nil {
			abs = pack
		}
		return design.NodeRunner{Pack: abs, Jail: jail}
	}
	print := func(cmd *cobra.Command, v any) error { return json.NewEncoder(cmd.OutOrStdout()).Encode(v) }

	c.AddCommand(&cobra.Command{
		Use:   "tweak <dir> <delta>",
		Short: "Apply a design delta (a file under dir) to the tree; fail when the edit needs an agent",
		Args:  cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			o, err := design.Step(cmd.Context(), runner(), args[0], args[1], func(context.Context) error { return errNeedsAgent })
			if errors.Is(err, errNeedsAgent) {
				return fmt.Errorf("%w: %s", errNeedsAgent, o.Reason)
			}
			if err != nil {
				return err
			}
			return print(cmd, o)
		},
	}, &cobra.Command{
		Use:   "stamp <dir>",
		Short: "Give every JSX element under dir one unique oid",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			files, err := design.Stamp(cmd.Context(), runner(), args[0])
			if err != nil {
				return err
			}
			return print(cmd, map[string][]string{"stamped": files})
		},
	})

	var strip bool
	edit := &cobra.Command{
		Use:   "edit <dir> <file> <requests.json>",
		Short: "Apply edit requests (a JSON list of requests) to a file and print the diff without writing it",
		Args:  cobra.ExactArgs(3),
		RunE: func(cmd *cobra.Command, args []string) error {
			raw, err := os.ReadFile(args[2])
			if err != nil {
				return err
			}
			var reqs []design.Request
			if err := json.Unmarshal(raw, &reqs); err != nil {
				return fmt.Errorf("design: %s: %w", args[2], err)
			}
			d, err := design.ApplyEdits(cmd.Context(), runner(), args[0], args[1], reqs, strip)
			if err != nil {
				return err
			}
			return print(cmd, d)
		},
	}
	edit.Flags().BoolVar(&strip, "strip-ids", false, "leave no data-oid or move key in the result")
	c.AddCommand(edit)
	return c
}
