package packs

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"

	"github.com/spf13/cobra"
)

// newRunCommand returns `run <pack.yaml> -- <command>`: it runs the command and re-runs it while the
// manifest's retry checks fail.
func newRunCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:          "run <pack.yaml> -- <command> [args]",
		Short:        "Run a command and retry it while the manifest's success checks fail",
		Args:         cobra.MinimumNArgs(2),
		SilenceUsage: true,
	}
	root := rootFlag(cmd)
	unlocked := cmd.Flags().Bool("unlocked", false, "run a pack that is not pinned in factory.lock (local authoring only)")
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		want := ""
		if *unlocked {
			_, _ = fmt.Fprintf(cmd.ErrOrStderr(), "warning: running %s without a factory.lock pin\n", args[0])
		} else {
			var err error
			if want, err = lockedSHA256(*root, args[0]); err != nil {
				return err
			}
		}
		m, err := LoadManifest(args[0], want)
		if err != nil {
			return err
		}
		if m.Retry == nil {
			return fmt.Errorf("%s has no retry block", args[0])
		}
		task := func(ctx context.Context) error {
			c := exec.CommandContext(ctx, args[1], args[2:]...)
			c.Stdout, c.Stderr = cmd.OutOrStdout(), cmd.ErrOrStderr()
			return c.Run()
		}
		return m.Retry.Run(cmd.Context(), "", task)
	}
	return cmd
}

// lockedSHA256 returns the factory.lock hash a pack file must have before its checks may run: the entry
// whose cache path is the file, else an entry whose hash is the file's. A pack in neither is refused.
func lockedSHA256(root, pack string) (string, error) {
	lockPath := filepath.Join(root, LockFile)
	lock, err := ReadLock(lockPath)
	if err != nil {
		return "", err
	}
	abs, err := filepath.Abs(pack)
	if err != nil {
		return "", err
	}
	b, err := readBounded(pack)
	if err != nil {
		return "", err
	}
	sum := digest(b)
	for _, e := range lock.Entries {
		r, err := ParseRef(e.Ref)
		if err != nil {
			return "", err
		}
		if c, err := filepath.Abs(cachePath(root, r)); err == nil && c == abs {
			return e.SHA256, nil
		}
	}
	for _, e := range lock.Entries {
		if e.SHA256 == sum {
			return e.SHA256, nil
		}
	}
	if _, err := os.Stat(lockPath); err != nil {
		return "", fmt.Errorf("pack %s is not pinned: no %s (use --unlocked to author locally)", pack, lockPath)
	}
	return "", fmt.Errorf("pack %s (sha256 %s) is not pinned in %s (use --unlocked to author locally)", pack, sum, lockPath)
}

// newMatchCommand returns `match <dir>`: it prints the skills in dir whose body would be injected.
func newMatchCommand() *cobra.Command {
	var touched []string
	var text string
	cmd := &cobra.Command{Use: "match <dir>", Short: "List the skill packs whose paths or keywords match", Args: cobra.ExactArgs(1), SilenceUsage: true}
	cmd.Flags().StringSliceVar(&touched, "path", nil, "a file the task touches (repeatable)")
	cmd.Flags().StringVar(&text, "text", "", "the task text")
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		files, err := filepath.Glob(filepath.Join(args[0], "*", "pack.yaml"))
		if err != nil {
			return err
		}
		var all []Manifest
		for _, f := range files {
			// Safe unlocked: match only parses the manifest and prints names; it never runs a retry check.
			m, err := LoadManifest(f, "")
			if err != nil {
				return err
			}
			all = append(all, *m)
		}
		for _, m := range Inject(all, touched, text) {
			if _, err := fmt.Fprintln(cmd.OutOrStdout(), m.Name); err != nil {
				return err
			}
		}
		return nil
	}
	return cmd
}
