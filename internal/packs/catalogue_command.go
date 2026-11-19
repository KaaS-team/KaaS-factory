package packs

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

// EnvCataloguePubKey names the env var that holds the base64 catalogue public key.
const EnvCataloguePubKey = "FACTORY_PACKS_PUBKEY"

// newInstallCommand is `packs install <name>[@version]`.
func newInstallCommand() *cobra.Command {
	return newInstallCommandWith(HTTPGetter{})
}

func newInstallCommandWith(g Getter) *cobra.Command {
	var catPath, key string
	cmd := &cobra.Command{
		Use:          "install <name>[@version]",
		Short:        "Install a pack from a signed catalogue",
		Args:         cobra.ExactArgs(1),
		SilenceUsage: true,
	}
	root := rootFlag(cmd)
	cmd.Flags().StringVar(&catPath, "catalogue", "", "catalogue file or URL; its signature is read from <catalogue>.sig")
	cmd.Flags().StringVar(&key, "pubkey", "", "base64 ed25519 public key (default: $"+EnvCataloguePubKey+")")
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		if catPath == "" {
			return fmt.Errorf("--catalogue is required")
		}
		if key == "" {
			key = os.Getenv(EnvCataloguePubKey)
		}
		pub, err := ParsePublicKey(key)
		if err != nil {
			return err
		}
		data, err := readSource(cmd, g, catPath)
		if err != nil {
			return err
		}
		sig, err := readSource(cmd, g, catPath+SigSuffix)
		if err != nil {
			return fmt.Errorf("catalogue signature: %w", err)
		}
		cat, err := VerifyCatalogue(data, sig, pub)
		if err != nil {
			return err
		}
		name, version, _ := strings.Cut(args[0], "@")
		e, err := cat.Find(name, version)
		if err != nil {
			return err
		}
		res, err := Install(cmd.Context(), g, *root, e)
		if err != nil {
			return err
		}
		if res.AlreadyInstalled {
			_, err = fmt.Fprintf(cmd.OutOrStdout(), "%s@%s already installed\n", res.Name, res.Version)
			return err
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "installed %s@%s to %s\n", res.Name, res.Version, res.Path)
		return err
	}
	return cmd
}

func readSource(cmd *cobra.Command, g Getter, src string) ([]byte, error) {
	if strings.HasPrefix(src, "https://") || strings.HasPrefix(src, "http://") {
		return g.Get(cmd.Context(), src)
	}
	return os.ReadFile(src)
}
