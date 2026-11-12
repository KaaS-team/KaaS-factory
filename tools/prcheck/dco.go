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
	return commitsIn(dir, base+".."+head)
}

// commitsIn lists the non-merge commits git log selects with revs.
func commitsIn(dir string, revs ...string) ([]Commit, error) {
	args := append([]string{"log", "--no-merges", "--format=%H%x1f%ae%x1f%B%x1e"}, revs...)
	out, err := gitOut(dir, args...)
	if err != nil {
		return nil, fmt.Errorf("git log %s: %w", strings.Join(revs, " "), err)
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
		sayln(stderr, "usage: prcheck dco <base> [head] | dco --unpushed")
		return 2
	}
	if args[0] == "--unpushed" {
		// The pre-push hook: only commits no origin ref has yet, so history already on the remote,
		// checked when it landed, never blocks a later push.
		commits, err := commitsIn(dir, "HEAD", "--not", "--remotes=origin")
		if err != nil {
			sayln(stderr, err)
			return 2
		}
		return report(unsigned(commits), "every unpushed commit is signed off", stdout, stderr)
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
	return report(unsigned(commits), fmt.Sprintf("every commit in %s..%s is signed off", base, head), stdout, stderr)
}

// report names every unsigned commit and returns 1, or prints ok and returns 0.
func report(bad []Commit, ok string, stdout, stderr io.Writer) int {
	for _, c := range bad {
		sayf(stderr, "%s has no Signed-off-by for %s (git commit -s)\n", c.SHA[:min(7, len(c.SHA))], c.Email)
	}
	if len(bad) > 0 {
		return 1
	}
	sayf(stdout, "dco: %s\n", ok)
	return 0
}
