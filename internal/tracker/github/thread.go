package github

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/marker"
	"github.com/KaaS-team/factory/internal/observe"
	"github.com/KaaS-team/factory/internal/store"
	gogithub "github.com/google/go-github/v79/github"
)

// The data-marker stages the loop writes and reads. The status marker lives in one comment the
// tracker edits in place; the others come from the stage skills (plan, verify, pr).
const (
	stageStatus = "status"
	stageAck    = "chatops"
	stagePlan   = "plan"
	stageVerify = "verify"
	stagePR     = "pr"
)

var (
	_ observe.Commander = (*Tracker)(nil)
	_ observe.Recorder  = (*Tracker)(nil)
	_ observe.PROpener  = (*Tracker)(nil)
)

// statusData is the payload of the status comment: the one record of when the run began and ended.
type statusData struct {
	Phase         string    `json:"phase"`
	FirstDispatch time.Time `json:"first_dispatch,omitzero"`
	MergedAt      time.Time `json:"merged_at,omitzero"`
}

func (t *Tracker) clock() time.Time {
	if t.now != nil {
		return t.now()
	}
	return time.Now()
}

// trust returns the trust rule for this repository, built once the token's own login is known.
func (t *Tracker) trust(ctx context.Context) (*Trust, error) {
	self, err := t.self(ctx)
	if err != nil {
		return nil, err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.trusted == nil {
		t.trusted = NewTrust(self, t.role, t.clock).WithActors(t.kindOf, t.bots)
	}
	return t.trusted, nil
}

// role reads a login's permission on the repository.
func (t *Tracker) role(ctx context.Context, login string) (Role, error) {
	lv, _, err := t.client.Repositories.GetPermissionLevel(ctx, t.owner, t.repo, login)
	if err != nil {
		return RoleNone, fmt.Errorf("github tracker: permission of %s: %w", login, err)
	}
	if name := lv.GetRoleName(); name != "" {
		return Role(name), nil
	}
	return Role(lv.GetPermission()), nil
}

// kindOf reads a login's account type. A 404 means an App with no user account.
func (t *Tracker) kindOf(ctx context.Context, login string) (string, error) {
	u, resp, err := t.client.Users.Get(ctx, login)
	if resp != nil && resp.StatusCode == http.StatusNotFound {
		return "", ErrNoSuchUser
	}
	return u.GetType(), err
}

// thread returns the issue's comments oldest first. A comment with a factory marker counts only
// when a trusted author wrote it, so a forged marker changes nothing.
func (t *Tracker) thread(ctx context.Context, n int) ([]Comment, error) {
	cs, err := t.comments(ctx, n)
	if err != nil {
		return nil, err
	}
	tr, err := t.trust(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Comment, 0, len(cs))
	for _, c := range cs {
		if strings.Contains(c.GetBody(), "<!-- factory:") && !tr.Trusted(ctx, c.GetUser().GetLogin()) {
			continue
		}
		out = append(out, Comment{ID: c.GetID(), Author: c.GetUser().GetLogin(), Body: c.GetBody(), CreatedAt: c.GetCreatedAt().Time})
	}
	return out, nil
}

// Thread reads what the issue thread says about the run: the status marker's first dispatch and
// merge times and how many `/factory` commands trusted humans wrote. It lets store.Rebuild restore
// those rows after the store is deleted.
func (t *Tracker) Thread(ctx context.Context, id api.TicketID) (store.Thread, error) {
	n, err := number(id)
	if err != nil {
		return store.Thread{}, err
	}
	cs, err := t.thread(ctx, n)
	if err != nil {
		return store.Thread{}, err
	}
	tr, err := t.trust(ctx)
	if err != nil {
		return store.Thread{}, err
	}
	self, err := t.self(ctx)
	if err != nil {
		return store.Thread{}, err
	}
	var th store.Thread
	if st, ok := readStatus(ownBy(cs, self)); ok {
		th.FirstDispatch, th.MergedAt = st.FirstDispatch, st.MergedAt
	}
	for _, c := range cs {
		if cmd, ok := tr.Command(ctx, c); ok && cmd.Kind != CmdAnswer {
			th.ChatopsCommands++
		}
	}
	th.ManualPushes, err = t.manualPushes(ctx, id, tr.self)
	return th, err
}

// manualPushes counts the repository's recent push events to the ticket's work branches whose
// actor is not the runner's login. GitHub keeps events for 90 days, which covers every ticket a
// rebuild lists (ready, active or parked).
func (t *Tracker) manualPushes(ctx context.Context, id api.TicketID, self string) (int, error) {
	prefix := "refs/heads/factory/" + string(id) + "-a"
	opts := &gogithub.ListOptions{PerPage: 100}
	n := 0
	for {
		evs, resp, err := t.client.Activity.ListRepositoryEvents(ctx, t.owner, t.repo, opts)
		if err != nil {
			return 0, fmt.Errorf("github tracker: list events: %w", err)
		}
		for _, e := range evs {
			p, _ := e.ParsePayload()
			if push, ok := p.(*gogithub.PushEvent); ok && strings.HasPrefix(push.GetRef(), prefix) && e.GetActor().GetLogin() != self {
				n++
			}
		}
		if resp.NextPage == 0 {
			return n, nil
		}
		opts.Page = resp.NextPage
	}
}

// ownBy keeps the comments login wrote. Status and ack markers are read from these alone: a
// maintainer is trusted for commands, but a marker in their comment says nothing about the run.
func ownBy(cs []Comment, login string) []Comment {
	var own []Comment
	for _, c := range cs {
		if c.Author == login {
			own = append(own, c)
		}
	}
	return own
}

func readStatus(cs []Comment) (statusData, bool) {
	c, ok := FindStatus(cs)
	if !ok {
		return statusData{}, false
	}
	raw, ok := marker.Latest(marker.ParseData(c.Body), stageStatus)
	var st statusData
	if !ok || json.Unmarshal(raw, &st) != nil {
		return statusData{}, false
	}
	return st, true
}

// RecordStatus writes the phase into the status comment, creating it on first use. Running sets the
// first dispatch time once; Merged sets the merge time; other phases only update the phase.
func (t *Tracker) RecordStatus(ctx context.Context, id api.TicketID, p api.Phase) error {
	n, err := number(id)
	if err != nil {
		return err
	}
	cs, err := t.thread(ctx, n)
	if err != nil {
		return err
	}
	self, err := t.self(ctx)
	if err != nil {
		return err
	}
	own := ownBy(cs, self)
	prev, _ := FindStatus(own)
	st, _ := readStatus(own)
	st.Phase = string(p)
	now := t.clock().UTC()
	if p == api.PhaseRunning && st.FirstDispatch.IsZero() {
		st.FirstDispatch = now
	}
	if p == api.PhaseMerged {
		st.MergedAt = now
	}
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	body := marker.EncodeData(marker.Status+" -->\nFactory status: "+string(p)+".", stageStatus, raw)
	if prev.ID != 0 {
		_, _, err = t.client.Issues.EditComment(ctx, t.owner, t.repo, prev.ID, &gogithub.IssueComment{Body: &body})
	} else {
		_, _, err = t.client.Issues.CreateComment(ctx, t.owner, t.repo, n, &gogithub.IssueComment{Body: &body})
	}
	if err != nil {
		return fmt.Errorf("github tracker: write status of %d: %w", n, err)
	}
	return nil
}

// acked lists the comment ids the loop already handled, from the runner's own comments.
func acked(cs []Comment) map[int64]bool {
	out := map[int64]bool{}
	for _, c := range cs {
		for _, m := range marker.ParseData(c.Body) {
			var d struct {
				Ref int64 `json:"ref"`
			}
			if m.Stage == stageAck && json.Unmarshal(m.JSON, &d) == nil {
				out[d.Ref] = true
			}
		}
	}
	return out
}

// Commands returns the retry, cancel, approve and revise commands trusted humans wrote that the loop has not yet
// acknowledged, oldest first. A comment from anyone else, or one that only looks like a command
// inside a marker, is ignored.
func (t *Tracker) Commands(ctx context.Context, id api.TicketID) ([]observe.Command, error) {
	n, err := number(id)
	if err != nil {
		return nil, err
	}
	cs, err := t.thread(ctx, n)
	if err != nil {
		return nil, err
	}
	tr, err := t.trust(ctx)
	if err != nil {
		return nil, err
	}
	self, err := t.self(ctx)
	if err != nil {
		return nil, err
	}
	done := acked(ownBy(cs, self))
	var out []observe.Command
	for _, c := range cs {
		cmd, ok := tr.Command(ctx, c)
		if !ok || done[c.ID] {
			continue
		}
		switch cmd.Kind {
		case CmdRetry:
			out = append(out, observe.Command{Verb: observe.VerbRetry, Ref: c.ID, Force: cmd.Force})
		case CmdCancel:
			out = append(out, observe.Command{Verb: observe.VerbCancel, Ref: c.ID})
		case CmdApprove:
			out = append(out, observe.Command{Verb: observe.VerbApprove, Ref: c.ID})
		case CmdRevise:
			out = append(out, observe.Command{Verb: observe.VerbRevise, Ref: c.ID, Text: cmd.Text})
		}
	}
	return out, nil
}

// Ack records on the thread that the command in comment ref was handled.
func (t *Tracker) Ack(ctx context.Context, id api.TicketID, ref int64) error {
	raw, err := json.Marshal(map[string]int64{"ref": ref})
	if err != nil {
		return err
	}
	return t.Comment(marker.Allow(ctx), id, marker.EncodeData("Handled the command in comment "+fmt.Sprint(ref)+".", stageAck, raw))
}

// stageText reads the latest marker for stage into v; false when there is none or it does not fit.
func stageText(cs []Comment, stage string, v any) bool {
	var bodies []string
	for _, c := range cs {
		bodies = append(bodies, c.Body)
	}
	raw, ok := marker.Latest(marker.ParseData(bodies...), stage)
	return ok && json.Unmarshal(raw, v) == nil
}

// OpenPR opens the draft pull request for a finished branch, its body rendered from the plan, the
// verdict and the pr stage's text in the thread. It returns 0 without opening when the branch has
// had a pull request, open or closed.
func (t *Tracker) OpenPR(ctx context.Context, id api.TicketID, branch, base string, files []string) (int, error) {
	n, err := number(id)
	if err != nil {
		return 0, err
	}
	existing, _, err := t.client.PullRequests.List(ctx, t.owner, t.repo, &gogithub.PullRequestListOptions{
		State: "all", Head: t.owner + ":" + branch, ListOptions: gogithub.ListOptions{PerPage: 1},
	})
	if err != nil {
		return 0, fmt.Errorf("github tracker: list pull requests of %s: %w", branch, err)
	}
	if len(existing) > 0 {
		return 0, nil
	}
	is, _, err := t.client.Issues.Get(ctx, t.owner, t.repo, n)
	if err != nil {
		return 0, fmt.Errorf("github tracker: read issue %d: %w", n, err)
	}
	cs, err := t.thread(ctx, n)
	if err != nil {
		return 0, err
	}
	var plan struct {
		Goal       string   `json:"goal"`
		Acceptance []string `json:"acceptance"`
	}
	var verdict struct {
		Proof *Proof `json:"proof"`
	}
	var pr struct {
		Body string `json:"body"`
	}
	stageText(cs, stagePlan, &plan)
	stageText(cs, stageVerify, &verdict)
	stageText(cs, stagePR, &pr)
	parts := PRParts{
		WhatChanged: RenderWhatChanged(cmpOr(plan.Goal, is.GetTitle()), files, verdict.Proof),
		RunDetails:  IssueRef(n),
	}
	if len(plan.Acceptance) > 0 {
		parts.Acceptance = "## Acceptance\n\n- [x] " + strings.Join(plan.Acceptance, "\n- [x] ")
	}
	text := pr.Body
	if text == "" {
		text = "Closes " + IssueRef(n)
	}
	body := RenderPRBody(text, parts)
	created, _, err := t.client.PullRequests.Create(ctx, t.owner, t.repo, &gogithub.NewPullRequest{
		Title: gogithub.Ptr(is.GetTitle()), Head: &branch, Base: &base, Body: &body, Draft: gogithub.Ptr(true),
	})
	if err != nil {
		return 0, fmt.Errorf("github tracker: open pull request for %s: %w", branch, err)
	}
	return created.GetNumber(), nil
}

func cmpOr(s, d string) string {
	if strings.TrimSpace(s) == "" {
		return d
	}
	return s
}
