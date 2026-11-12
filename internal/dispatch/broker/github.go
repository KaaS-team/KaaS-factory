package broker

import (
	"context"
	"net/url"
	"strings"
	"time"
)

// GitHub is the adapter for api.github.com. It hands out the source token with a short expiry;
// it does not narrow the token's own scopes, so the gate on the classified action is the limit.
type GitHub struct {
	TTL time.Duration    // lifetime of a minted credential
	Now func() time.Time // defaults to time.Now
}

var githubVerbs = []string{"repo.read", "pr.create", "pr.update", "issue.comment", "contents.write"}

// Type returns "github".
func (GitHub) Type() string { return "github" }

// Actions lists every verb Classify can return.
func (GitHub) Actions() []string { return append([]string(nil), githubVerbs...) }

// Open reads the secret once to prove it is usable, then returns a connector that rereads it per mint.
func (g GitHub) Open(ctx context.Context, src Source) (Connector, error) {
	if _, err := src.Secret(ctx); err != nil {
		return nil, err
	}
	if g.Now == nil {
		g.Now = time.Now
	}
	return &githubConn{g: g, src: src}, nil
}

type githubConn struct {
	g   GitHub
	src Source
}

func (*githubConn) Type() string { return "github" }

// Classify maps a REST call to a verb. Anything not listed, including every DELETE and merge, is ErrUnclassified.
func (*githubConn) Classify(method, target string) (Action, error) {
	u, err := url.Parse(target)
	if err != nil {
		return Action{}, ErrUnclassified
	}
	p := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(p) < 3 || p[0] != "repos" || p[1] == "" || p[2] == "" {
		return Action{}, ErrUnclassified
	}
	rest := p[3:]
	verb := ""
	switch {
	case method == "GET" || method == "HEAD":
		verb = "repo.read"
	case method == "POST" && len(rest) == 1 && rest[0] == "pulls":
		verb = "pr.create"
	case method == "PATCH" && len(rest) == 2 && rest[0] == "pulls":
		verb = "pr.update"
	case method == "POST" && len(rest) == 3 && rest[0] == "issues" && rest[2] == "comments":
		verb = "issue.comment"
	case method == "PUT" && len(rest) >= 2 && rest[0] == "contents":
		verb = "contents.write"
	case method == "POST" && len(rest) == 2 && rest[0] == "git" && rest[1] == "refs":
		verb = "contents.write"
	default:
		return Action{}, ErrUnclassified
	}
	return Action{Type: "github", Verb: verb, Resource: p[1] + "/" + p[2]}, nil
}

// Mint returns the source token expiring TTL from now, for an action of this adapter.
func (c *githubConn) Mint(ctx context.Context, a Action) (Credential, error) {
	ok := false
	for _, v := range githubVerbs {
		ok = ok || (a.Type == "github" && a.Verb == v)
	}
	if !ok {
		return Credential{}, ErrUnclassified
	}
	s, err := c.src.Secret(ctx)
	if err != nil {
		return Credential{}, err
	}
	return Credential{Type: "github", Value: s, ExpiresAt: c.g.Now().Add(c.g.TTL)}, nil
}
