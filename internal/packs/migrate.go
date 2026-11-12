package packs

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/packs/migration"
)

func newMigrateCommand() *cobra.Command {
	cmd := &cobra.Command{
		Use:          "migrate <owner/repo#path>",
		Short:        "Run a migration pack pinned in factory.lock over the repository",
		Args:         cobra.ExactArgs(1),
		SilenceUsage: true,
	}
	root := rootFlag(cmd)
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		ref, err := ParseRef(args[0])
		if err != nil {
			return err
		}
		lock, err := ReadLock(filepath.Join(*root, LockFile))
		if err != nil {
			return err
		}
		e, ok := lock.Find(KindWorkflow, ref)
		if !ok {
			return fmt.Errorf("%s is not pinned in %s; run `factory add %s --kind workflow` first", args[0], LockFile, args[0])
		}
		pinned, err := ParseRef(e.Ref)
		if err != nil {
			return err
		}
		b, err := os.ReadFile(cachePath(*root, pinned))
		if err != nil {
			return err
		}
		if err := migration.Verify(e.SHA256, b); err != nil {
			return err
		}
		p, err := migration.Load(b)
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		_, err = migration.Run(cmd.Context(), p, migration.Options{Root: *root, Exec: migration.ExecRunner{Out: out}, Log: out})
		return err
	}
	return cmd
}
