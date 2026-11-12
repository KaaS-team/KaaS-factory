package packs

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Fetched is one file at one commit, with the licence of the repository at that commit.
type Fetched struct {
	SHA     string
	Content []byte
	Licence string
}

// Fetcher reads a file from a repository at a revision (a sha, tag or branch; empty means HEAD).
type Fetcher interface {
	Fetch(ctx context.Context, slug, rev, path string) (Fetched, error)
}

// GitFetcher fetches with the git binary. Remote maps owner/repo to a git URL or local path;
// Cache is a directory where it keeps one bare repository per slug.
type GitFetcher struct {
	Remote func(slug string) string
	Cache  string
}

func (g GitFetcher) git(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(errb.String()))
	}
	return out.Bytes(), nil
}

// Fetch updates the cached bare repository, resolves rev to a commit and reads path and the licence from it.
func (g GitFetcher) Fetch(ctx context.Context, slug, rev, path string) (Fetched, error) {
	dir := filepath.Join(g.Cache, strings.ReplaceAll(slug, "/", "__")+".git")
	if _, err := os.Stat(dir); err != nil {
		if _, err := g.git(ctx, "", "init", "--bare", "--quiet", dir); err != nil {
			return Fetched{}, err
		}
	}
	if _, err := g.git(ctx, dir, "fetch", "--quiet", "--tags", "--force", g.Remote(slug), "+refs/heads/*:refs/remotes/origin/*"); err != nil {
		return Fetched{}, err
	}
	if rev == "" {
		rev = "FETCH_HEAD"
		if _, err := g.git(ctx, dir, "fetch", "--quiet", g.Remote(slug), "HEAD"); err != nil {
			return Fetched{}, err
		}
	}
	sha, err := g.git(ctx, dir, "rev-parse", "--verify", rev+"^{commit}")
	if err != nil {
		return Fetched{}, err
	}
	full := strings.TrimSpace(string(sha))
	content, err := g.git(ctx, dir, "show", full+":"+path)
	if err != nil {
		return Fetched{}, err
	}
	licence := "NOASSERTION"
	for _, name := range []string{"LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"} {
		if b, err := g.git(ctx, dir, "show", full+":"+name); err == nil {
			licence = DetectLicence(b)
			break
		}
	}
	return Fetched{SHA: full, Content: content, Licence: licence}, nil
}
