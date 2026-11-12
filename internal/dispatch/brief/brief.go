// Package brief renders an api.Brief to the markdown file a session reads
// from the cloud-briefs branch, and names that file.
package brief

import (
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/KaaS-team/factory/internal/api"
)

var (
	safeTicket = regexp.MustCompile(`^[A-Za-z0-9._-]+$`)
	safeRef    = regexp.MustCompile(`^[A-Za-z0-9._/-]+$`)
)

// Name returns the file name v9-<ticket>-a<attempt>.md. It refuses a ticket
// id that is not a plain file name part.
func Name(ticket api.TicketID, attempt int) (string, error) {
	if !safeTicket.MatchString(string(ticket)) || strings.HasPrefix(string(ticket), ".") {
		return "", fmt.Errorf("brief: ticket id %q is not usable in a file name", ticket)
	}
	if attempt < 1 {
		return "", fmt.Errorf("brief: attempt %d is below 1", attempt)
	}
	return fmt.Sprintf("v9-%s-a%d.md", ticket, attempt), nil
}

// Render returns the markdown for b: a header naming the repo, base and
// branch, the git steps to start, then b.Text. Model and budget are left out
// because the brief is committed to the repo; the meter enforces budgets.
func Render(b api.Brief) (string, error) {
	if _, err := Name(b.Ticket, b.Attempt); err != nil {
		return "", err
	}
	if b.Repo == "" || strings.TrimSpace(b.Text) == "" {
		return "", errors.New("brief: repo and text are required")
	}
	for _, ref := range []struct{ what, v string }{{"branch", b.Branch}, {"base", b.Base}} {
		if !safeRef.MatchString(ref.v) || strings.HasPrefix(ref.v, "-") {
			return "", fmt.Errorf("brief: %s %q is not a plain git ref", ref.what, ref.v)
		}
	}
	var s strings.Builder
	fmt.Fprintf(&s, "# Ticket %s, attempt %d\n\n", b.Ticket, b.Attempt)
	fmt.Fprintf(&s, "- Repo: %s\n- Base: %s\n- Branch: %s\n", b.Repo, b.Base, b.Branch)
	if b.Workflow != "" {
		fmt.Fprintf(&s, "- Workflow: %s\n", b.Workflow)
	}
	if b.Node != "" {
		fmt.Fprintf(&s, "- Node: %s\n", b.Node)
	}
	fmt.Fprintf(&s, "\nStart with `git fetch origin && git checkout -b %s origin/%s`, commit on that branch and push it. Do not push to %s.\n\n", b.Branch, b.Base, b.Base)
	s.WriteString(strings.TrimRight(b.Text, "\n") + "\n")
	return s.String(), nil
}

// Prompt returns the session prompt for a brief file: read it from the
// briefs branch, then follow it.
func Prompt(name string) string {
	return fmt.Sprintf("Run `git fetch origin cloud-briefs && git show origin/cloud-briefs:%s`, then follow that brief exactly.", name)
}
