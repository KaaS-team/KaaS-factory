package smoke

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
	"github.com/KaaS-team/factory/internal/core"
	"github.com/KaaS-team/factory/internal/dispatch/brief"
	"github.com/KaaS-team/factory/internal/dispatch/local"
	"github.com/KaaS-team/factory/internal/dispatch/shadow"
	"github.com/KaaS-team/factory/internal/gitx"
	"github.com/KaaS-team/factory/internal/mergeq"
	"github.com/KaaS-team/factory/internal/mergeq/wire"
	"github.com/KaaS-team/factory/internal/meter"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/observe/ghsource"
	"github.com/KaaS-team/factory/internal/reconcile"
	"github.com/KaaS-team/factory/internal/store"
	ghtracker "github.com/KaaS-team/factory/internal/tracker/github"
	gogithub "github.com/google/go-github/v79/github"
)

// greenGate is the gate command of the smoke queue: the sandbox repo has no gates script, so the
// queue's gate prints the one line the runner accepts as a pass.
const greenGate = `echo "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-"`

// Config says where to run and how long to wait.
type Config struct {
	Owner, Repo string
	Token       string
	// APIURL is the GitHub API root; empty means api.github.com.
	APIURL string
	// RemoteURL is the git remote of the repository; empty means https://github.com/<owner>/<repo>.git.
	// Credentials for it come from the ambient git environment, never from this value.
	RemoteURL string
	Base      string // base branch, "main" when empty
	Shadow    bool   // run in shadow mode: nothing is dispatched or merged
	Dir       string // scratch directory for clones, the store and logs; required
	Poll      time.Duration
	Timeout   time.Duration
	// ShadowTicks is how many loop passes a shadow run makes (3 when zero).
	ShadowTicks int
	Now         func() time.Time
}

// Result is what a run left on GitHub, read back after the loop stopped.
type Result struct {
	Issue      int
	Title      string
	File       string // path the ticket asked for
	PR         int    // 0 when no pull request exists
	Merged     bool   // GitHub reports the pull request merged
	FileOnBase bool   // the file exists on the base branch
	Comments   int    // comments on the issue, by anyone
	Labels     []string
	Dispatches int // dispatches the shadow dispatcher recorded
}

func (c Config) withDefaults() (Config, error) {
	switch {
	case c.Owner == "" || c.Repo == "" || c.Token == "":
		return c, errors.New("smoke: owner, repo and token are required")
	case c.Dir == "":
		return c, errors.New("smoke: Dir is required")
	}
	if c.Base == "" {
		c.Base = "main"
	}
	if c.APIURL == "" {
		c.APIURL = "https://api.github.com"
	}
	c.APIURL = strings.TrimRight(c.APIURL, "/")
	if c.RemoteURL == "" {
		c.RemoteURL = "https://github.com/" + c.Owner + "/" + c.Repo + ".git"
	}
	if c.Poll <= 0 {
		c.Poll = 5 * time.Second
	}
	if c.Timeout <= 0 {
		c.Timeout = 5 * time.Minute
	}
	if c.ShadowTicks <= 0 {
		c.ShadowTicks = 3
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	return c, nil
}

type bearer struct{ token string }

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return http.DefaultTransport.RoundTrip(r)
}

func (c Config) httpClient() *http.Client {
	return &http.Client{Transport: bearer{c.Token}, Timeout: 60 * time.Second}
}

func (c Config) client() (*gogithub.Client, error) {
	gc := gogithub.NewClient(c.httpClient())
	u, err := gc.BaseURL.Parse(c.APIURL + "/")
	if err != nil {
		return nil, fmt.Errorf("smoke: bad API URL %q: %w", c.APIURL, err)
	}
	gc.BaseURL = u
	return gc, nil
}

// nameFixer gives the local dispatcher the brief file name it checks for. The reconcile loop names
// a brief "<ticket>-a<n>.md" and the local dispatcher wants "v9-<ticket>-a<n>.md".
type nameFixer struct{ api.Dispatcher }

func (n nameFixer) Dispatch(ctx context.Context, b api.Brief) (api.Session, error) {
	name, err := brief.Name(b.Ticket, b.Attempt)
	if err != nil {
		return api.Session{}, err
	}
	b.Name = name
	return n.Dispatcher.Dispatch(ctx, b)
}

// shadowQueue lists the queue but never runs it, so a shadow run merges nothing.
type shadowQueue struct{ core.MergeQueue }

func (shadowQueue) Enqueue(context.Context, api.TicketID, int) error { return nil }
func (shadowQueue) Run(context.Context) (mergeq.Report, error) {
	return mergeq.Report{}, errors.New("merge queue does not run in shadow mode")
}

type recorder struct{ records []shadow.Record }

func (r *recorder) Write(rec shadow.Record) error { r.records = append(r.records, rec); return nil }

func git(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("git %s: %w: %s", args[0], err, strings.TrimSpace(string(out)))
	}
	return strings.TrimSpace(string(out)), nil
}

// Run creates the smoke issue and drives the real loop (GitHub tracker, local dispatcher running
// the fake agent, the merge queue) until the work lands, or, for a shadow run, for a fixed number
// of passes. It returns what GitHub holds afterward. On an error the Result still names the issue,
// so the caller can Cleanup.
func Run(ctx context.Context, cfg Config) (Result, error) {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return Result{}, err
	}
	gc, err := cfg.client()
	if err != nil {
		return Result{}, err
	}
	ts := cfg.Now().UTC().Format("20060102T150405Z")
	res := Result{Title: "smoke " + ts, File: "smoke/" + ts + ".txt"}
	is, _, err := gc.Issues.Create(ctx, cfg.Owner, cfg.Repo, &gogithub.IssueRequest{
		Title: &res.Title, Body: gogithub.Ptr(issueBody(res.File)), Labels: &[]string{ghtracker.LabelReady},
	})
	if err != nil {
		return res, fmt.Errorf("smoke: create issue: %w", err)
	}
	res.Issue = is.GetNumber()

	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()
	rec := &recorder{}
	runErr := drive(ctx, cfg, gc, res, rec)
	// Read back with a fresh context: the run's own may have ended.
	rctx, rcancel := context.WithTimeout(context.WithoutCancel(ctx), 60*time.Second)
	defer rcancel()
	if err := readBack(rctx, cfg, gc, &res); err != nil && runErr == nil {
		runErr = err
	}
	res.Dispatches = len(rec.records)
	return res, runErr
}

func issueBody(file string) string {
	return "Planned by the smoke test.\n\n## Plan\n\n- Add one file, `" + file + "`, with one line of text.\n- Change nothing else.\n"
}

func logTail(path string) string {
	b, err := os.ReadFile(path)
	if err != nil || len(b) == 0 {
		return ""
	}
	if len(b) > 2000 {
		b = b[len(b)-2000:]
	}
	return "\nagent log:\n" + string(b)
}

func drive(ctx context.Context, cfg Config, gc *gogithub.Client, res Result, rec *recorder) error {
	clone := func(name string) (string, error) {
		dir := filepath.Join(cfg.Dir, name)
		if _, err := git(ctx, cfg.Dir, "clone", "-q", cfg.RemoteURL, dir); err != nil {
			return "", err
		}
		return dir, nil
	}
	agentRepo, err := clone("agent")
	if err != nil {
		return err
	}
	queueRepo, err := clone("queue")
	if err != nil {
		return err
	}
	script := filepath.Join(cfg.Dir, "fake-agent.sh")
	if err := os.WriteFile(script, []byte(agentScript), 0o755); err != nil {
		return err
	}
	agentLog := filepath.Join(cfg.Dir, "agent.log")

	tr, err := ghtracker.New(ghtracker.Config{Owner: cfg.Owner, Repo: cfg.Repo, HTTPClient: cfg.httpClient(), BaseURL: cfg.APIURL + "/"})
	if err != nil {
		return err
	}
	runCtx, stopRuns := context.WithCancel(ctx)
	defer stopRuns()
	env := append(os.Environ(),
		"SMOKE_FILE="+res.File, "SMOKE_API_URL="+cfg.APIURL, "SMOKE_REPO="+cfg.Owner+"/"+cfg.Repo,
		"SMOKE_BASE="+cfg.Base, "SMOKE_TOKEN="+cfg.Token, "SMOKE_LOG="+agentLog)
	ld, err := local.New(runCtx, local.Config{
		Worktrees: local.GitWorktrees{Repo: agentRepo, Root: filepath.Join(cfg.Dir, "worktrees")},
		Binary:    script, Environ: env, MaxConcurrent: 1,
	})
	if err != nil {
		return err
	}
	var disp api.Dispatcher = nameFixer{ld}
	disp = shadow.Wrap(disp, config.Config{Shadow: cfg.Shadow}, rec)

	st, err := store.Open(filepath.Join(cfg.Dir, "factory.db"))
	if err != nil {
		return err
	}
	defer func() { _ = st.Close() }()

	g := gitx.New(queueRepo)
	var queue core.MergeQueue = mergeq.NewCoreQueue(mergeq.Deps{
		Tracker: tr, Git: wire.Git{G: g}, Gate: wire.Gate{G: g, Command: greenGate},
		Heads: wire.Heads{Client: gc, Owner: cfg.Owner, Repo: cfg.Repo}, Cfg: mergeq.Config{},
	})
	if cfg.Shadow {
		queue = shadowQueue{queue}
	}
	var loopErrs []error
	c, err := core.New(core.Deps{
		Tracker: tr, Dispatcher: disp, Observer: observe.New(ghsource.New(gc, cfg.Owner, cfg.Repo, cfg.Base)),
		Store: st, Meter: meter.New(meter.Budgets{}, cfg.Now), Queue: queue,
		OnError: func(e error) { loopErrs = append(loopErrs, e) },
	}, core.Config{
		Reconcile: reconcile.Config{Tick: cfg.Poll, MaxAttempts: 1, MaxConcurrent: 1, Base: cfg.Base},
		Team:      cfg.Owner + "/" + cfg.Repo,
	})
	if err != nil {
		return err
	}

	for n := 1; ; n++ {
		c.Tick(ctx)
		if cfg.Shadow {
			if n >= cfg.ShadowTicks {
				return nil
			}
		} else if done, err := finished(ctx, cfg, gc, res); err != nil {
			return err
		} else if done {
			return nil
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("smoke: not finished after %s: %w (loop errors: %v)%s", cfg.Timeout, ctx.Err(), loopErrs, logTail(agentLog))
		case <-time.After(cfg.Poll):
		}
	}
}

// finished reports whether the work landed. A needs-human label is a failure.
func finished(ctx context.Context, cfg Config, gc *gogithub.Client, res Result) (bool, error) {
	r := res
	if err := readBack(ctx, cfg, gc, &r); err != nil {
		return false, err
	}
	if slices.Contains(r.Labels, ghtracker.LabelNeedsHuman) {
		return false, fmt.Errorf("smoke: issue #%d went to needs-human", r.Issue)
	}
	return r.Merged && r.FileOnBase, nil
}

// readBack fills res from GitHub: labels, comments, the pull request and the base branch.
func readBack(ctx context.Context, cfg Config, gc *gogithub.Client, res *Result) error {
	is, _, err := gc.Issues.Get(ctx, cfg.Owner, cfg.Repo, res.Issue)
	if err != nil {
		return fmt.Errorf("smoke: read issue: %w", err)
	}
	res.Labels = res.Labels[:0]
	for _, l := range is.Labels {
		res.Labels = append(res.Labels, l.GetName())
	}
	cs, _, err := gc.Issues.ListComments(ctx, cfg.Owner, cfg.Repo, res.Issue, &gogithub.IssueListCommentsOptions{ListOptions: gogithub.ListOptions{PerPage: 100}})
	if err != nil {
		return fmt.Errorf("smoke: read comments: %w", err)
	}
	res.Comments = len(cs)
	prs, _, err := gc.PullRequests.List(ctx, cfg.Owner, cfg.Repo, &gogithub.PullRequestListOptions{
		Head: cfg.Owner + ":" + observe.WorkBranch(api.TicketID(fmt.Sprint(res.Issue)), 1), State: "all",
	})
	if err != nil {
		return fmt.Errorf("smoke: read pull requests: %w", err)
	}
	res.PR, res.Merged = 0, false
	if len(prs) > 0 {
		p, _, err := gc.PullRequests.Get(ctx, cfg.Owner, cfg.Repo, prs[0].GetNumber())
		if err != nil {
			return fmt.Errorf("smoke: read pull request: %w", err)
		}
		res.PR, res.Merged = p.GetNumber(), p.GetMerged()
	}
	_, _, resp, err := gc.Repositories.GetContents(ctx, cfg.Owner, cfg.Repo, res.File, &gogithub.RepositoryContentGetOptions{Ref: cfg.Base})
	switch {
	case err == nil:
		res.FileOnBase = true
	case resp != nil && resp.StatusCode == http.StatusNotFound:
		res.FileOnBase = false
	default:
		return fmt.Errorf("smoke: read %s on %s: %w", res.File, cfg.Base, err)
	}
	return nil
}

// Cleanup closes the issue and its pull request and deletes the ticket's branches. It does not
// revert a merge: the file stays on the base branch. It keeps going after a failed step and
// returns every error it met.
func Cleanup(ctx context.Context, cfg Config, res Result) error {
	cfg, err := cfg.withDefaults()
	if err != nil {
		return err
	}
	if res.Issue == 0 {
		return nil
	}
	gc, err := cfg.client()
	if err != nil {
		return err
	}
	var errs []error
	if res.PR != 0 && !res.Merged { // GitHub refuses to close a merged pull request
		if _, _, err := gc.PullRequests.Edit(ctx, cfg.Owner, cfg.Repo, res.PR, &gogithub.PullRequest{State: gogithub.Ptr("closed")}); err != nil {
			errs = append(errs, fmt.Errorf("close pull request %d: %w", res.PR, err))
		}
	}
	if _, _, err := gc.Issues.Edit(ctx, cfg.Owner, cfg.Repo, res.Issue, &gogithub.IssueRequest{State: gogithub.Ptr("closed")}); err != nil {
		errs = append(errs, fmt.Errorf("close issue %d: %w", res.Issue, err))
	}
	id := api.TicketID(fmt.Sprint(res.Issue))
	for _, br := range []string{observe.WorkBranch(id, 1), observe.ReportBranch(id)} {
		_, err := gc.Git.DeleteRef(ctx, cfg.Owner, cfg.Repo, "heads/"+br)
		if err != nil && !alreadyGone(err) {
			errs = append(errs, fmt.Errorf("delete branch %s: %w", br, err))
		}
	}
	return errors.Join(errs...)
}

// alreadyGone reports whether GitHub said the ref is not there (404, or 422 for a missing ref).
func alreadyGone(err error) bool {
	var er *gogithub.ErrorResponse
	if !errors.As(err, &er) || er.Response == nil {
		return false
	}
	code := er.Response.StatusCode
	return code == http.StatusNotFound || code == http.StatusUnprocessableEntity
}
