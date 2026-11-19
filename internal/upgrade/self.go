package upgrade

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/selfupdate"
)

// NewSelfCommand returns `upgrade`: it replaces the running binary at exe (this process when empty)
// with the latest release from src, after checking its checksum. With --check it only reports.
func NewSelfCommand(current string, src selfupdate.Source, exe string) *cobra.Command {
	var check bool
	cmd := &cobra.Command{
		Use:   "upgrade",
		Short: "Replace this binary with the latest factory release",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			out := cmd.OutOrStdout()
			rel, newer, err := selfupdate.Check(cmd.Context(), current, src)
			if err != nil {
				return err
			}
			if !newer {
				_, _ = fmt.Fprintf(out, "factory %s is current\n", current)
				return nil
			}
			if check {
				_, _ = fmt.Fprintf(out, "factory %s is available (this is %s); run `factory upgrade`\n", rel.Version, current)
				return nil
			}
			if err := selfupdate.Apply(cmd.Context(), rel, src, exe, "", ""); err != nil {
				return err
			}
			_, _ = fmt.Fprintf(out, "upgraded factory %s to %s\n", current, rel.Version)
			return nil
		},
	}
	cmd.Flags().BoolVar(&check, "check", false, "report whether a newer release exists and change nothing")
	return cmd
}
