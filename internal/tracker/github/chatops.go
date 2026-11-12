package github

import (
	"context"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Role is a login's permission on the repository.
type Role string

// Repository roles, as GitHub reports them.
const (
	RoleAdmin    Role = "admin"
	RoleMaintain Role = "maintain"
	RoleWrite    Role = "write"
	RoleTriage   Role = "triage"
	RoleRead     Role = "read"
	RoleNone     Role = "none"
)

// Trusted reports whether the role is write access or higher (src/ports/scm.ts TRUSTED_ROLES).
func (r Role) Trusted() bool { return r == RoleAdmin || r == RoleMaintain || r == RoleWrite }

// CommandKind names what a comment asks for.
type CommandKind string

// The ChatOps verbs, plus a plain-text answer to the latest open question.
const (
	CmdApprove CommandKind = "approve"
	CmdRevise  CommandKind = "revise"
	CmdRetry   CommandKind = "retry"
	CmdCancel  CommandKind = "cancel"
	CmdAnswer  CommandKind = "answer"
)

// Command is a parsed comment. Text is revise feedback or an answer; Force and Step belong to retry.
type Command struct {
	Kind  CommandKind
	Text  string
	Force bool
	Step  string
}

var (
	commandRE   = regexp.MustCompile(`(?is)^\s*/factory\s+(approve|revise|retry|cancel)\b\s*(.*)$`)
	signatureRE = regexp.MustCompile(`\n*<sub>Sent from the factory control plane by [^<\n]+</sub>\s*$`)
)

// SignedBy appends the control-plane signature line naming who sent the body.
func SignedBy(body, who string) string {
	sep := ""
	if body != "" {
		sep = "\n\n"
	}
	return body + sep + "<sub>Sent from the factory control plane by " + who + "</sub>"
}

// Unsigned removes a trailing control-plane signature line.
func Unsigned(body string) string { return signatureRE.ReplaceAllString(body, "") }

// ParseChatOps turns a comment body into a command: a `/factory <verb>` line, or
// else a plain-text answer. It does no trust check; use Trust.Command for that.
func ParseChatOps(body string) Command {
	body = Unsigned(body)
	m := commandRE.FindStringSubmatch(body)
	if m == nil {
		return Command{Kind: CmdAnswer, Text: strings.TrimSpace(body)}
	}
	rest := strings.TrimSpace(m[2])
	switch strings.ToLower(m[1]) {
	case "approve":
		return Command{Kind: CmdApprove}
	case "cancel":
		return Command{Kind: CmdCancel}
	case "retry":
		c := Command{Kind: CmdRetry}
		for _, w := range strings.Fields(rest) {
			if w == "--force" {
				c.Force = true
			} else if c.Step == "" {
				c.Step = strings.ToLower(w)
			}
		}
		return c
	default:
		return Command{Kind: CmdRevise, Text: rest}
	}
}

// RoleCacheTTL is how long a login's role is remembered, so a waiting issue does not cost an API call per poll.
const RoleCacheTTL = 5 * time.Minute

type cachedRole struct {
	role Role
	at   time.Time
}

// Trust decides whose comments count. One rule for labels and commands: the
// runner's own login, or write access or higher. An author association alone
// is not enough, since a read-only collaborator is a COLLABORATOR too.
type Trust struct {
	self   string
	roleOf func(ctx context.Context, login string) (Role, error)
	now    func() time.Time
	mu     sync.Mutex
	cache  map[string]cachedRole
}

// NewTrust builds a Trust for the runner login self. roleOf looks a login up
// on the repository; a failed lookup trusts nobody.
func NewTrust(self string, roleOf func(ctx context.Context, login string) (Role, error), now func() time.Time) *Trust {
	return &Trust{self: self, roleOf: roleOf, now: now, cache: map[string]cachedRole{}}
}

// Trusted reports whether login is the runner or has write access or higher.
func (t *Trust) Trusted(ctx context.Context, login string) bool {
	if login == "" {
		return false
	}
	if t.self != "" && login == t.self {
		return true
	}
	t.mu.Lock()
	hit, ok := t.cache[login]
	t.mu.Unlock()
	if ok && t.now().Sub(hit.at) < RoleCacheTTL {
		return hit.role.Trusted()
	}
	role, err := t.roleOf(ctx, login)
	if err != nil {
		return false
	}
	t.mu.Lock()
	t.cache[login] = cachedRole{role: role, at: t.now()}
	t.mu.Unlock()
	return role.Trusted()
}

// Command parses c when a trusted author wrote it and it is not one of the
// runner's own marker comments. Anyone else's words are ignored (ok is false),
// so a read-only collaborator's text never becomes a command or an answer.
func (t *Trust) Command(ctx context.Context, c Comment) (Command, bool) {
	if strings.Contains(c.Body, "<!-- factory:") || !t.Trusted(ctx, c.Author) {
		return Command{}, false
	}
	return ParseChatOps(c.Body), true
}

// TrustedOnly keeps the comments the runner or a writer wrote, whatever their bodies say.
func (t *Trust) TrustedOnly(ctx context.Context, comments []Comment) []Comment {
	var out []Comment
	for _, c := range comments {
		if t.Trusted(ctx, c.Author) {
			out = append(out, c)
		}
	}
	return out
}
