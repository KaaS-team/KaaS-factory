// Package packs resolves skills, agent presets, workflows and checks by reference and pins them in a lock file.
package packs

import (
	"fmt"
	"regexp"
	"strings"
)

// Ref names one file in a GitHub repository: owner/repo@sha#path. SHA is empty until resolved.
type Ref struct {
	Owner, Repo, SHA, Path string
}

var (
	nameRe = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)
	shaRe  = regexp.MustCompile(`^[0-9a-f]{7,40}$`)
	pathRe = regexp.MustCompile(`^[A-Za-z0-9._/+@=,-]+$`)
)

// ParseRef parses owner/repo[@sha]#path and rejects anything malformed.
func ParseRef(s string) (Ref, error) {
	head, path, ok := strings.Cut(s, "#")
	if !ok || path == "" {
		return Ref{}, fmt.Errorf("ref %q: want owner/repo[@sha]#path", s)
	}
	slug, sha, hasSHA := strings.Cut(head, "@")
	owner, repo, ok := strings.Cut(slug, "/")
	if !ok || !nameRe.MatchString(owner) || !nameRe.MatchString(repo) {
		return Ref{}, fmt.Errorf("ref %q: want owner/repo before the sha", s)
	}
	if hasSHA && !shaRe.MatchString(sha) {
		return Ref{}, fmt.Errorf("ref %q: sha must be 7 to 40 lowercase hex digits", s)
	}
	if !pathRe.MatchString(path) || strings.HasPrefix(path, "/") {
		return Ref{}, fmt.Errorf("ref %q: bad path", s)
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return Ref{}, fmt.Errorf("ref %q: bad path segment %q", s, seg)
		}
	}
	return Ref{Owner: owner, Repo: repo, SHA: sha, Path: path}, nil
}

// Slug returns owner/repo.
func (r Ref) Slug() string { return r.Owner + "/" + r.Repo }

// String formats the ref as owner/repo[@sha]#path.
func (r Ref) String() string {
	s := r.Owner + "/" + r.Repo
	if r.SHA != "" {
		s += "@" + r.SHA
	}
	return s + "#" + r.Path
}
