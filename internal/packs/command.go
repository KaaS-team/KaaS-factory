package packs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

const (
	cacheFiles = "files"
	cacheRepos = "repos"
	shortHash  = 12
)

var hexRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// NewAddCommand returns `add <repo>#<path>[@ref]`, which pins one upstream file in factory.lock and caches it under .factory/cache.
func NewAddCommand() *cobra.Command {
	return newAddCommand(func(cache string) Fetcher {
		return GitFetcher{Cache: cache, Remote: func(slug string) string { return "https://github.com/" + slug + ".git" }}
	})
}

// NewPacksCommand returns `packs` with the `list` and `verify` subcommands.
func NewPacksCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "packs", Short: "Inspect the packs pinned in factory.lock"}
	cmd.AddCommand(newListCommand(), newVerifyCommand())
	return cmd
}

func rootFlag(cmd *cobra.Command) *string {
	return cmd.Flags().String("root", ".", "repository root holding factory.lock and .factory/cache")
}

func cachePath(root string, r Ref) string {
	return filepath.Join(root, ".factory", "cache", cacheFiles, r.Owner, r.Repo, r.SHA, filepath.FromSlash(r.Path))
}

// recorder keeps the last file a Fetcher returned, so the command can cache what the resolver hashed.
type recorder struct {
	Fetcher
	last Fetched
}

func (r *recorder) Fetch(ctx context.Context, slug, rev, p string) (Fetched, error) {
	f, err := r.Fetcher.Fetch(ctx, slug, rev, p)
	if err == nil {
		r.last = f
	}
	return f, err
}

// splitSource splits repo#path[@ref] into a ref string the parser accepts and an optional non-sha revision.
func splitSource(arg string) (refStr, rev string, err error) {
	head, tail, ok := strings.Cut(arg, "#")
	if !ok || tail == "" {
		return "", "", fmt.Errorf("source %q: want owner/repo#path[@ref]", arg)
	}
	if i := strings.LastIndex(tail, "@"); i > 0 {
		tail, rev = tail[:i], tail[i+1:]
		if rev == "" {
			return "", "", fmt.Errorf("source %q: empty ref after @", arg)
		}
	}
	if rev != "" && strings.Contains(head, "@") {
		return "", "", fmt.Errorf("source %q: give the ref once", arg)
	}
	return head + "#" + tail, rev, nil
}

func inferKind(p string) (Kind, error) {
	for _, seg := range strings.Split(p, "/") {
		switch seg {
		case "skills":
			return KindSkill, nil
		case "agents":
			return KindAgent, nil
		case "workflows":
			return KindWorkflow, nil
		case "checks":
			return KindCheck, nil
		}
	}
	return "", fmt.Errorf("cannot tell the kind of %s: pass --kind skill|agent|workflow|check", p)
}

func newAddCommand(fetcher func(cache string) Fetcher) *cobra.Command {
	var kindFlag string
	cmd := &cobra.Command{
		Use:          "add <repo>#<path>[@ref]",
		Short:        "Pin a file from a GitHub repository (MIT or Apache-2.0 only) in factory.lock",
		Args:         cobra.ExactArgs(1),
		SilenceUsage: true,
	}
	root := rootFlag(cmd)
	cmd.Flags().StringVar(&kindFlag, "kind", "", "skill, agent, workflow or check (default: from the path)")
	cmd.RunE = func(cmd *cobra.Command, args []string) error {
		refStr, rev, err := splitSource(args[0])
		if err != nil {
			return err
		}
		ref, err := ParseRef(refStr)
		if err != nil {
			return err
		}
		kind := Kind(kindFlag)
		if kindFlag == "" {
			if kind, err = inferKind(ref.Path); err != nil {
				return err
			}
		} else if !kind.Valid() {
			return fmt.Errorf("unknown kind %q", kindFlag)
		}
		lockPath := filepath.Join(*root, LockFile)
		lock, err := ReadLock(lockPath)
		if err != nil {
			return err
		}
		rec := &recorder{Fetcher: fetcher(filepath.Join(*root, ".factory", "cache", cacheRepos))}
		if rev != "" {
			// A branch or tag is resolved to its sha first; a sha goes straight to the resolver.
			if !hexRe.MatchString(rev) {
				f, err := rec.Fetch(cmd.Context(), ref.Slug(), rev, ref.Path)
				if err != nil {
					return fmt.Errorf("fetch %s: %w", ref, err)
				}
				rev = f.SHA
			}
			ref.SHA = rev
			refStr = ref.String()
		}
		e, err := (&Resolver{Fetcher: rec, Lock: lock}).Resolve(cmd.Context(), kind, refStr)
		if err != nil {
			return err
		}
		got, err := ParseRef(e.Ref)
		if err != nil {
			return err
		}
		if err := writeFile(cachePath(*root, got), rec.last.Content); err != nil {
			return err
		}
		next, err := lock.Marshal()
		if err != nil {
			return err
		}
		if prev, err := os.ReadFile(lockPath); err != nil || !bytes.Equal(prev, next) {
			if err := os.WriteFile(lockPath, next, 0o644); err != nil {
				return err
			}
		}
		_, err = fmt.Fprintf(cmd.OutOrStdout(), "pinned %s %s %s\n", e.Kind, e.Ref, e.Licence)
		return err
	}
	return cmd
}

func writeFile(p string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o644)
}

type listRow struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Source  string `json:"source"`
	Licence string `json:"licence"`
	Hash    string `json:"hash"`
}

// entryID names an entry by its directory when the file is SKILL.md, and by its file stem otherwise.
func entryID(p string) string {
	base := path.Base(p)
	if base == "SKILL.md" && path.Dir(p) != "." {
		return path.Base(path.Dir(p))
	}
	return strings.TrimSuffix(base, path.Ext(base))
}

func newListCommand() *cobra.Command {
	var asJSON bool
	cmd := &cobra.Command{Use: "list", Short: "Print each lock entry", Args: cobra.NoArgs, SilenceUsage: true}
	root := rootFlag(cmd)
	cmd.Flags().BoolVar(&asJSON, "json", false, "print JSON")
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		lock, err := ReadLock(filepath.Join(*root, LockFile))
		if err != nil {
			return err
		}
		rows := []listRow{}
		for _, e := range lock.Entries {
			r, err := ParseRef(e.Ref)
			if err != nil {
				return err
			}
			rows = append(rows, listRow{ID: entryID(r.Path), Kind: string(e.Kind), Source: e.Ref, Licence: e.Licence, Hash: e.SHA256[:min(shortHash, len(e.SHA256))]})
		}
		out := cmd.OutOrStdout()
		if asJSON {
			b, err := json.MarshalIndent(rows, "", "  ")
			if err != nil {
				return err
			}
			_, err = fmt.Fprintln(out, string(b))
			return err
		}
		tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
		for _, r := range rows {
			_, _ = fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", r.ID, r.Kind, r.Source, r.Licence, r.Hash)
		}
		return tw.Flush()
	}
	return cmd
}

func newVerifyCommand() *cobra.Command {
	cmd := &cobra.Command{Use: "verify", Short: "Re-hash the cache against factory.lock", Args: cobra.NoArgs, SilenceUsage: true}
	root := rootFlag(cmd)
	cmd.RunE = func(cmd *cobra.Command, _ []string) error {
		lock, err := ReadLock(filepath.Join(*root, LockFile))
		if err != nil {
			return err
		}
		out := cmd.OutOrStdout()
		bad := 0
		for _, e := range lock.Entries {
			r, err := ParseRef(e.Ref)
			if err != nil {
				return err
			}
			b, err := os.ReadFile(cachePath(*root, r))
			switch {
			case err != nil:
				bad++
				_, _ = fmt.Fprintf(out, "missing: %s (%s)\n", r.Path, e.Ref)
			default:
				h := sha256.Sum256(b)
				if got := hex.EncodeToString(h[:]); got != e.SHA256 {
					bad++
					_, _ = fmt.Fprintf(out, "mismatch: %s (%s): lock has %s, cache has %s\n", r.Path, e.Ref, e.SHA256, got)
				}
			}
		}
		if bad > 0 {
			return fmt.Errorf("%d pack file(s) failed verification", bad)
		}
		_, err = fmt.Fprintf(out, "ok: %d pack file(s) match factory.lock\n", len(lock.Entries))
		return err
	}
	return cmd
}
