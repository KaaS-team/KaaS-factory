package browsercheck

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// NewCommand returns `browsercheck`, the command the browser check pack runs. It prints one
// FACTORY_GATES line and exits non-zero when a step fails or Chrome is missing.
func NewCommand() *cobra.Command {
	var stepsFile, outDir string
	cmd := &cobra.Command{
		Use:   "browsercheck",
		Short: "Run browser steps in headless Chrome and print one FACTORY_GATES line",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			data, err := os.ReadFile(stepsFile)
			if err != nil {
				return fmt.Errorf("browser: %w", err)
			}
			steps, err := ParseSteps(data)
			if err != nil {
				return fmt.Errorf("browser: %s: %w", stepsFile, err)
			}
			res := Run(cmd.Context(), Options{Steps: steps, OutDir: outDir})
			_, _ = fmt.Fprintln(cmd.OutOrStdout(), res.Line())
			if res.Failed > 0 {
				return fmt.Errorf("%s", res.Message)
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&stepsFile, "steps", ".factory/browser-steps.yaml", "YAML file of browser steps")
	cmd.Flags().StringVar(&outDir, "out", ".factory/browser-out", "directory for screenshots")
	return cmd
}
