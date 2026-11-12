package repomap

import (
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
)

var skipDirs = map[string]bool{".git": true, "node_modules": true, "vendor": true, "dist": true, ".factory": true}

var sourceExt = map[string]bool{".go": true, ".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".py": true}

// sourceFiles lists the parseable files under root, relative and slash separated.
func sourceFiles(root string) ([]string, error) {
	var files []string
	err := filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if p != root && skipDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		if sourceExt[strings.ToLower(filepath.Ext(p))] {
			rel, _ := filepath.Rel(root, p)
			files = append(files, filepath.ToSlash(rel))
		}
		return nil
	})
	return files, err
}

// NewCommand returns `repomap`, which prints a ranked symbol map of the repository within a token budget.
func NewCommand() *cobra.Command {
	var root, ticket string
	var budget int
	cmd := &cobra.Command{
		Use:   "repomap",
		Short: "Print a ranked, token-budgeted symbol map of the repository for a context pack",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			files, err := sourceFiles(root)
			if err != nil {
				return err
			}
			cachePath := filepath.Join(root, ".factory", "cache", "repomap.json")
			cache, err := LoadCache(cachePath)
			if err != nil {
				cache = NewCache()
			}
			mf, mi := Mentions(ticket, files)
			out, err := Build(cmd.Context(), Options{Root: root, Others: files, MentionedFiles: mf, MentionedIdents: mi, Budget: budget, Cache: cache})
			if err != nil {
				return err
			}
			if os.MkdirAll(filepath.Dir(cachePath), 0o755) == nil {
				_ = cache.Save(cachePath)
			}
			_, err = fmt.Fprint(cmd.OutOrStdout(), out)
			return err
		},
	}
	cmd.Flags().StringVar(&root, "root", ".", "repository root")
	cmd.Flags().StringVar(&ticket, "ticket", "", "ticket text; files and identifiers it names seed the ranking")
	cmd.Flags().IntVar(&budget, "budget", 1024, "token budget of the map")
	return cmd
}
