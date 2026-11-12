// Ported from anthropics/claude-code-action@8a29bc6 src/github/operations/session-guard.ts
// MIT, Copyright (c) Anthropic, PBC, 2025. Ported to Go by hand.

package untrusted

import (
	"bytes"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
)

// sensitivePaths are read from the working directory at agent start and a pull request can set them.
var sensitivePaths = []string{".claude", ".mcp.json", ".claude.json", ".gitmodules", ".ripgreprc", "CLAUDE.md", "CLAUDE.local.md", ".husky"}

const maxFile = 64 << 20

type kind int

const (
	absent kind = iota
	file
	link
	dir
	opaque // a FIFO, device or oversized file: left alone
)

type entry struct {
	kind    kind
	content []byte
	target  string
	mode    fs.FileMode
}

// Guard holds the state of the sensitive paths and git config files taken before a session.
type Guard struct {
	roots   []string
	entries map[string]entry
}

func snap(path string) entry {
	fi, err := os.Lstat(path)
	switch {
	case err != nil:
		return entry{kind: absent}
	case fi.Mode()&fs.ModeSymlink != 0:
		t, err := os.Readlink(path)
		if err != nil {
			return entry{kind: opaque}
		}
		return entry{kind: link, target: t}
	case fi.IsDir():
		return entry{kind: dir, mode: fi.Mode().Perm()}
	case !fi.Mode().IsRegular() || fi.Size() > maxFile:
		return entry{kind: opaque}
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return entry{kind: opaque}
	}
	return entry{kind: file, content: b, mode: fi.Mode().Perm()}
}

func same(a, b entry) bool {
	return a.kind == b.kind && a.target == b.target && bytes.Equal(a.content, b.content) && (a.kind != file || a.mode == b.mode)
}

// gitConfigs lists the config files git reads in dir, includes followed.
func gitConfigs(dir string) []string {
	var out []string
	if b, err := exec.Command("git", "-C", dir, "rev-parse", "--path-format=absolute", "--git-path", "config").Output(); err == nil {
		out = append(out, strings.TrimSpace(string(b)))
	}
	if b, err := exec.Command("git", "-C", dir, "config", "--list", "--includes", "--show-origin", "--name-only", "-z").Output(); err == nil {
		for i, tok := range strings.Split(string(b), "\x00") {
			if p, ok := strings.CutPrefix(tok, "file:"); ok && i%2 == 0 {
				if !filepath.IsAbs(p) {
					p = filepath.Join(dir, p)
				}
				out = append(out, p)
			}
		}
	}
	return out
}

func walk(root string, fn func(path string)) {
	_ = filepath.WalkDir(root, func(p string, _ fs.DirEntry, err error) error {
		if err == nil {
			fn(p)
		}
		return nil
	})
}

// Snapshot records the state of the sensitive paths in the base branch's tree (base is a ref git
// resolves in dir, such as origin/main) and of every git config file git reads in dir. The
// checkout's own copies are the pull request's, so they are never the state to restore to: a path
// the base lacks is recorded as absent and Restore removes it.
func Snapshot(wt, base string) (*Guard, error) {
	g := &Guard{entries: map[string]entry{}}
	for _, p := range gitConfigs(wt) {
		g.entries[p] = snap(p)
	}
	args := append([]string{"-C", wt, "ls-tree", "-r", "-z", base, "--"}, sensitivePaths...)
	out, err := exec.Command("git", args...).Output()
	if err != nil {
		return nil, fmt.Errorf("untrusted: read %s: %w", base, err)
	}
	for _, p := range sensitivePaths {
		root := filepath.Join(wt, p)
		g.roots = append(g.roots, root)
		g.entries[root] = entry{kind: absent}
	}
	for _, rec := range strings.Split(string(out), "\x00") {
		meta, name, ok := strings.Cut(rec, "\t")
		f := strings.Fields(meta)
		if !ok || len(f) != 3 {
			continue
		}
		path := filepath.Join(wt, filepath.FromSlash(name))
		e := entry{kind: opaque} // a submodule is left alone
		switch f[0] {
		case "100644", "100755":
			b, err := exec.Command("git", "-C", wt, "cat-file", "blob", f[2]).Output()
			if err != nil {
				return nil, fmt.Errorf("untrusted: read %s:%s: %w", base, name, err)
			}
			e = entry{kind: file, content: b, mode: 0o644}
			if f[0] == "100755" {
				e.mode = 0o755
			}
		case "120000":
			b, err := exec.Command("git", "-C", wt, "cat-file", "blob", f[2]).Output()
			if err != nil {
				return nil, fmt.Errorf("untrusted: read %s:%s: %w", base, name, err)
			}
			e = entry{kind: link, target: string(b)}
		}
		for d := filepath.Dir(path); d != wt && len(d) > len(wt); d = filepath.Dir(d) {
			g.entries[d] = entry{kind: dir, mode: 0o755}
		}
		g.entries[path] = e
	}
	return g, nil
}

// Restore puts everything the snapshot recorded back, removes what the session added under the
// sensitive paths, and returns the paths it changed. A replaced file is removed first and then
// created, so a link the session planted is never written through.
func (g *Guard) Restore() ([]string, error) {
	var changed []string
	var firstErr error
	note := func(p string, err error) {
		if err != nil && firstErr == nil {
			firstErr = err
		}
		changed = append(changed, p)
	}
	for _, r := range g.roots { // added by the session
		walk(r, func(p string) {
			if _, was := g.entries[p]; !was && snap(p).kind != absent {
				note(p, os.RemoveAll(p))
			}
		})
	}
	paths := make([]string, 0, len(g.entries))
	for p := range g.entries {
		paths = append(paths, p)
	}
	sort.Strings(paths) // parents before children
	for _, p := range paths {
		want := g.entries[p]
		if want.kind == opaque || same(want, snap(p)) {
			continue
		}
		_ = os.RemoveAll(p)
		var err error
		switch want.kind {
		case file:
			err = os.MkdirAll(filepath.Dir(p), 0o755)
			if err == nil {
				err = os.WriteFile(p, want.content, want.mode)
			}
		case link:
			err = os.Symlink(want.target, p)
		case dir:
			err = os.MkdirAll(p, want.mode)
		}
		note(p, err)
	}
	return changed, firstErr
}
