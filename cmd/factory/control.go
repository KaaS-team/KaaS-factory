package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/dispatch/fire"
	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/dispatch/routines"
	"github.com/KaaS-team/factory/internal/dispatch/shadow"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/mergeq/wire"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/observe/ghsource"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
	"github.com/KaaS-team/factory/internal/tracker/github"
	"github.com/KaaS-team/factory/internal/tracker/jira"
	"github.com/KaaS-team/factory/internal/tracker/linear"
	gogithub "github.com/google/go-github/v79/github"
)

// newControl builds the api.Control every command talks to. Tests replace it with a fake.
var newControl = func(cfg config.Config) (api.Control, error) {
	d, err := newDeps(cfg)
	if err != nil {
		return nil, err
	}
	return core.New(d, coreConfig(cfg))
}

// newDeps builds the loop's ports from the config. Tests replace it to run a real Core on fakes.
var newDeps = buildDeps

// The environment variables the adapters read. Config holds names and ids, never secrets.
const (
	envGitHubToken   = "GITHUB_TOKEN"
	envGitHubURL     = "GITHUB_API_URL"
	envLinearToken   = "LINEAR_API_KEY"
	envLinearURL     = "LINEAR_API_URL"
	envJiraToken     = "JIRA_API_TOKEN"
	envJiraURL       = "JIRA_URL"
	envRoutinesToken = "CLAUDE_ROUTINES_TOKEN"
	envRoutinesURL   = "CLAUDE_ROUTINES_URL"
	envRoutine       = "CLAUDE_ROUTINE_ID"

	defaultRoutinesURL = "https://api.anthropic.com"
	readyLabel         = "factory:ready"
	dbPath             = ".factory/cache/factory.db"
)

// trackers is one row per tracker adapter. The key is the value of the `tracker` config key.
var trackers = map[string]func(config.Config) (api.Tracker, error){
	"github": func(c config.Config) (api.Tracker, error) {
		g, err := newGitHubConn(c)
		if err != nil {
			return nil, err
		}
		return g.tracker()
	},
	"linear": func(c config.Config) (api.Tracker, error) {
		return linear.New(linear.Config{Team: c.Repo, TokenEnv: envLinearToken, BaseURL: os.Getenv(envLinearURL), ReadyLabel: readyLabel})
	},
	"jira": func(c config.Config) (api.Tracker, error) {
		return jira.New(jira.Config{BaseURL: os.Getenv(envJiraURL), Project: c.Repo, TokenEnv: envJiraToken, ReadyLabel: readyLabel})
	},
}

// dispatchers is one row per dispatcher adapter. The key is the value of the `dispatcher` config key.
var dispatchers = map[string]func(context.Context, config.Config) (api.Dispatcher, error){
	"claude-cloud": func(_ context.Context, c config.Config) (api.Dispatcher, error) {
		tok := os.Getenv(envRoutinesToken)
		if tok == "" {
			return nil, fmt.Errorf("dispatcher claude-cloud: env var %s is not set", envRoutinesToken)
		}
		return routines.New(routines.Config{BaseURL: routinesURL(), Token: tok, MaxConcurrent: c.Slots})
	},
	"fire": func(_ context.Context, c config.Config) (api.Dispatcher, error) {
		tok, id := os.Getenv(envRoutinesToken), os.Getenv(envRoutine)
		switch {
		case tok == "":
			return nil, fmt.Errorf("dispatcher fire: env var %s is not set", envRoutinesToken)
		case id == "":
			return nil, fmt.Errorf("dispatcher fire: env var %s is not set", envRoutine)
		}
		return fire.New(fire.Config{BaseURL: routinesURL(), Token: tok, Routine: id, Limiter: fire.NewLimiter(time.Now), MaxConcurrent: c.Slots})
	},
	"local": func(ctx context.Context, c config.Config) (api.Dispatcher, error) {
		repo, err := os.Getwd()
		if err != nil {
			return nil, err
		}
		root := filepath.Join(repo, ".factory", "worktrees")
		return local.New(ctx, local.Config{Worktrees: local.GitWorktrees{Repo: repo, Root: root}, MaxConcurrent: c.Slots})
	},
}

// gitHubConn is what the GitHub tracker, observer source and merge queue share: one repo, one token.
type gitHubConn struct {
	owner, repo, baseURL string
	http                 *http.Client
}

func newGitHubConn(c config.Config) (gitHubConn, error) {
	owner, repo, ok := strings.Cut(c.Repo, "/")
	if !ok || owner == "" || repo == "" {
		return gitHubConn{}, fmt.Errorf("tracker github: key repo must be owner/name, got %q", c.Repo)
	}
	tok := os.Getenv(envGitHubToken)
	if tok == "" {
		return gitHubConn{}, fmt.Errorf("tracker github: env var %s is not set", envGitHubToken)
	}
	return gitHubConn{owner: owner, repo: repo, baseURL: os.Getenv(envGitHubURL),
		http: &http.Client{Timeout: 30 * time.Second, Transport: bearer{tok, http.DefaultTransport}}}, nil
}

func (g gitHubConn) tracker() (*github.Tracker, error) {
	return github.New(github.Config{Owner: g.owner, Repo: g.repo, BaseURL: g.baseURL, HTTPClient: g.http})
}

func (g gitHubConn) client() (*gogithub.Client, error) {
	c := gogithub.NewClient(g.http)
	if g.baseURL != "" {
		u, err := url.Parse(strings.TrimSuffix(g.baseURL, "/") + "/")
		if err != nil || u.Scheme == "" || u.Host == "" {
			return nil, fmt.Errorf("github: bad %s %q", envGitHubURL, g.baseURL)
		}
		c.BaseURL = u
	}
	return c, nil
}

// gitHubParts builds the GitHub observer source and merge queue for the repository in the working
// directory. Other trackers keep the not-configured stand-ins.
func gitHubParts(c config.Config, tr *github.Tracker) (api.Observer, core.MergeQueue, error) {
	g, err := newGitHubConn(c)
	if err != nil {
		return nil, nil, err
	}
	client, err := g.client()
	if err != nil {
		return nil, nil, err
	}
	dir, err := os.Getwd()
	if err != nil {
		return nil, nil, err
	}
	q, err := wire.New(tr, dir, mergeq.Config{}, client, g.owner, g.repo)
	if err != nil {
		return nil, nil, err
	}
	return observe.New(ghsource.New(client, g.owner, g.repo, c.Base)), q, nil
}

// recorded stores every session it dispatches, so `factory logs` can find a ticket's latest one.
type recorded struct {
	api.Dispatcher
	st *store.Store
}

func (r recorded) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	s, err := r.Dispatcher.Dispatch(ctx, b)
	if err != nil {
		return s, err
	}
	// Dispatch is idempotent per attempt, so a failed write is safe to retry on the next tick.
	if err := r.st.PutSession(ctx, s); err != nil {
		return s, fmt.Errorf("record session %s: %w", s.Key, err)
	}
	return s, nil
}

func routinesURL() string {
	if u := os.Getenv(envRoutinesURL); u != "" {
		return u
	}
	return defaultRoutinesURL
}

// bearer adds an Authorization header to every request.
type bearer struct {
	token string
	next  http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.next.RoundTrip(r)
}

func pick[T any](port, key string, table map[string]T) (T, error) {
	f, ok := table[key]
	if !ok {
		var zero T
		names := make([]string, 0, len(table))
		for n := range table {
			names = append(names, n)
		}
		sort.Strings(names)
		return zero, fmt.Errorf("%s: unknown %q (allowed: %s)", port, key, strings.Join(names, ", "))
	}
	return f, nil
}

func buildTracker(c config.Config) (api.Tracker, error) {
	f, err := pick("tracker", c.Tracker, trackers)
	if err != nil {
		return nil, err
	}
	return f(c)
}

func buildDispatcher(ctx context.Context, c config.Config) (api.Dispatcher, error) {
	f, err := pick("dispatcher", c.Dispatcher, dispatchers)
	if err != nil {
		return nil, err
	}
	return f(ctx, c)
}

func buildDeps(c config.Config) (core.Deps, error) {
	trk, err := buildTracker(c)
	if err != nil {
		return core.Deps{}, err
	}
	// The dispatcher lives as long as the process; its context is cancelled when the process ends.
	disp, err := buildDispatcher(context.Background(), c)
	if err != nil {
		return core.Deps{}, err
	}
	disp = shadow.Wrap(disp, c, shadow.NewFileWriter(shadow.DefaultPath))
	st, err := openStore()
	if err != nil {
		return core.Deps{}, err
	}
	var obs api.Observer = observe.New(notConfiguredSource{})
	var queue core.MergeQueue = notConfiguredQueue{}
	if gt, ok := trk.(*github.Tracker); ok {
		if obs, queue, err = gitHubParts(c, gt); err != nil {
			return core.Deps{}, err
		}
	}
	if c.Shadow {
		// Shadow mode writes nothing to the repo: the queue lists entries but never merges.
		queue = shadowQueue{queue}
	}
	b := func(usd float64) api.Budget { return api.Budget{USD: usd} }
	return core.Deps{
		Tracker: trk, Dispatcher: recorded{disp, st}, Observer: obs, Store: st,
		Meter: meter.New(meter.Budgets{Node: b(c.Budgets.Node), Ticket: b(c.Budgets.Ticket), TeamDay: b(c.Budgets.TeamDay)}, time.Now),
		Queue: queue, Clock: core.RealClock{},
	}, nil
}

func openStore() (*store.Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, err
	}
	return store.Open(dbPath)
}

func coreConfig(c config.Config) core.Config {
	return core.Config{
		Reconcile: reconcile.Config{Tick: c.PollInterval, StallAfter: c.StallAfter, MaxAttempts: c.MaxRetries, MaxConcurrent: c.Slots, Base: c.Base},
		Team:      c.Repo,
		Budget:    api.Budget{USD: c.Budgets.Ticket},
	}
}

// notConfiguredQueue stands in for the merge queue on trackers other than GitHub.
type notConfiguredQueue struct{}

func (notConfiguredQueue) Enqueue(context.Context, api.TicketID, int) error { return nil }
func (notConfiguredQueue) Queued(context.Context) ([]mergeq.Entry, error)   { return nil, nil }
func (notConfiguredQueue) Run(context.Context) (mergeq.Report, error) {
	return mergeq.Report{}, errors.New("merge queue is not configured in this build")
}

// shadowQueue reads the wrapped queue but refuses Run, so shadow mode never merges or pushes.
type shadowQueue struct{ core.MergeQueue }

func (shadowQueue) Enqueue(context.Context, api.TicketID, int) error { return nil }
func (shadowQueue) Run(context.Context) (mergeq.Report, error) {
	return mergeq.Report{}, errors.New("merge queue does not run in shadow mode")
}

// notConfiguredSource stands in for the observer source on trackers other than GitHub.
type notConfiguredSource struct{}

var errNoSource = errors.New("observer source is not configured in this build")

func (notConfiguredSource) Branch(context.Context, string) (time.Time, bool, error) {
	return time.Time{}, false, errNoSource
}
func (notConfiguredSource) PullRequest(context.Context, string) (observe.PR, bool, error) {
	return observe.PR{}, false, errNoSource
}
func (notConfiguredSource) Checks(context.Context, int) (observe.Checks, error) {
	return observe.ChecksNone, errNoSource
}
func (notConfiguredSource) DiffFiles(context.Context, string) ([]string, error) {
	return nil, errNoSource
}
