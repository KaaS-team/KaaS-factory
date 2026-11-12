// Ported from scripts/dco.ts at ts-final
package main

import (
	"fmt"
	"io"
	"regexp"
	"strings"
)

// Commit is one commit's sha, author address and full message.
type Commit struct {
	SHA   string
	Email string
	Body  string
}

// bot matches GitHub's own bots, which cannot sign; everything else must, with the author's own address.
var bot = regexp.MustCompile(`\[bot\]@users\.noreply\.github\.com$`)

var signoff = regexp.MustCompile(`(?m)^Signed-off-by: .+ <([^>]+)>\s*$`)

// unsigned returns the commits with no Signed-off-by trailer for their own author address.
func unsigned(commits []Commit) []Commit {
	var out []Commit
	for _, c := range commits {
		if bot.MatchString(c.Email) {
			continue
		}
		signed := false
		for _, m := range signoff.FindAllStringSubmatch(c.Body, -1) {
			if strings.EqualFold(m[1], c.Email) {
				signed = true
			}
		}
		if !signed {
			out = append(out, c)
		}
	}
	return out
}

// commitsBetween lists the non-merge commits in base..head.
func commitsBetween(dir, base, head string) ([]Commit, error) {
	out, err := gitOut(dir, "log", "--no-merges", "--format=%H%x1f%ae%x1f%B%x1e", base+".."+head)
	if err != nil {
		return nil, fmt.Errorf("git log %s..%s: %w", base, head, err)
	}
	var commits []Commit
	for _, rec := range strings.Split(string(out), "\x1e") {
		rec = strings.TrimSpace(rec)
		if rec == "" {
			continue
		}
		parts := strings.SplitN(rec, "\x1f", 3)
		if len(parts) != 3 {
			continue
		}
		commits = append(commits, Commit{parts[0], parts[1], parts[2]})
	}
	return commits, nil
}

func runDCO(dir string, args []string, stdout, stderr io.Writer) int {
	if len(args) < 1 {
		sayln(stderr, "usage: prcheck dco <base> [head]")
		return 2
	}
	base, head := args[0], "HEAD"
	if len(args) > 1 {
		head = args[1]
	}
	commits, err := commitsBetween(dir, base, head)
	if err != nil {
		sayln(stderr, err)
		return 2
	}
	bad := unsigned(commits)
	for _, c := range bad {
		sayf(stderr, "%s has no Signed-off-by for %s (git commit -s)\n", c.SHA[:min(7, len(c.SHA))], c.Email)
	}
	if len(bad) > 0 {
		return 1
	}
	sayf(stdout, "dco: every commit in %s..%s is signed off\n", base, head)
	return 0
}
