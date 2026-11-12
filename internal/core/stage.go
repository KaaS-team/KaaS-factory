package core

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/graph/interrupt"
	"github.com/KaaS-team/factory/internal/tutor"
)

// Stages makes the loop run each ticket through a workflow graph, one session per node.
// Without it a ticket is one session, as before.
type Stages struct {
	// Graph loads the workflow a ticket names; "" asks for the default.
	Graph func(name string) (*graph.Graph, error)
	// Policy picks the tier of a node that does not pin one. A zero Policy leaves the tier empty.
	Policy tutor.Policy
}

// stageRun is where one ticket stands in its graph. Node runs take their own attempt numbers, so each
// gets its own session and branch; base counts the attempts finished nodes used, and the reconcile
// loop's attempt n is attempt base+n everywhere outside it.
type stageRun struct {
	g       *graph.Graph
	node    string
	tier    string
	base    int
	fails   int
	pr      int
	history []tutor.Attempt
	input   string // revise feedback for the next brief of this node
}

func (c *Core) stageOf(id api.TicketID, workflow string) (*stageRun, error) {
	if st, ok := c.stages[id]; ok {
		return st, nil
	}
	g, err := c.d.Stages.Graph(workflow)
	if err != nil {
		return nil, err
	}
	st := &stageRun{g: g, node: g.Start}
	c.stages[id] = st
	return st, nil
}

// tierFor is the node's pinned tier, else the tutor's pick; a verify node takes the review tier when the policy has one.
func (c *Core) tierFor(st *stageRun, n graph.Node) string {
	if n.Tier != "" {
		return n.Tier
	}
	d := c.d.Stages.Policy.Next(st.history)
	if n.Verify && d.Review {
		return d.ReviewTier
	}
	return d.Tier
}

// stageBrief fits a brief the reconcile loop built to the ticket's current node: the node, its tier and
// token budget, and an attempt number and branch no earlier node used.
func (c *Core) stageBrief(b api.Brief) (api.Brief, error) {
	st, err := c.stageOf(b.Ticket, b.Workflow)
	if err != nil {
		return b, err
	}
	n, ok := st.g.Node(st.node)
	if !ok {
		return b, fmt.Errorf("workflow %s: no node %q", st.g.Name, st.node)
	}
	st.tier = c.tierFor(st, n)
	b.Attempt += st.base
	b.Branch = fmt.Sprintf("factory/%s-a%d", b.Ticket, b.Attempt)
	b.Workflow, b.Node, b.Model = st.g.Name, n.ID, st.tier
	if n.Budget > 0 {
		b.Budget.Tokens = int64(n.Budget)
	}
	if n.Prompt != "" || st.g.Prompt != "" {
		t := c.tickets[b.Ticket]
		text, err := st.g.RenderPrompt(n.ID, map[string]any{"ticket": map[string]any{"title": t.Title, "body": t.Body}, "attempt": b.Attempt})
		if err != nil {
			return b, err
		}
		b.Text = text
	}
	if st.input != "" {
		b.Text += "\n\nRevision requested:\n" + st.input
	}
	return b, nil
}

// advance runs when a node's session has finished its work: it picks the next node from the graph.
// It reports true when the ticket moves on to another node, so the ticket is not done yet.
func (c *Core) advance(ctx context.Context, id api.TicketID) (bool, error) {
	st, ok := c.stages[id]
	if !ok {
		return false, nil
	}
	e := c.state.Entries[id]
	o := c.lastObs[id]
	if o.PR > 0 {
		st.pr = o.PR
	}
	n, _ := st.g.Node(st.node)
	outcome := graph.Pass
	if n.Verify && o.ChecksGreen != nil && !*o.ChecksGreen {
		outcome = graph.Fail
	}
	st.record(n)
	next, err := st.g.Next(st.node, outcome)
	switch {
	case errors.Is(err, graph.ErrNoEdge):
		c.escalate(ctx, id, fmt.Sprintf("workflow %s: node %s has no %s edge", st.g.Name, st.node, outcome))
		return true, nil
	case err != nil:
		return false, err
	}
	if outcome == graph.Fail {
		if st.fails++; st.fails >= c.cfg.Reconcile.MaxAttempts {
			c.escalate(ctx, id, fmt.Sprintf("%s failed %d times", st.node, st.fails))
			return true, nil
		}
	}
	if next == graph.End {
		c.lastObs[id] = withPR(o, st.pr)
		delete(c.stages, id)
		return false, nil
	}
	st.node, st.base = next, st.base+e.Attempt
	c.hub.emit(KindStage, id, map[string]any{"node": next, "after": n.ID, "outcome": string(outcome)})
	if h, _ := st.g.Node(next); h.Kind == graph.KindHuman {
		c.escalate(ctx, id, "plan approval")
		c.raise(ctx, id, next)
		c.stages[id] = st // escalate forgets the stage; approve and revise need it
	}
	return true, nil
}

// resume answers a ticket waiting at a human node: approve takes the pass edge, revise the revise edge
// with text as the next brief's input. The ticket goes back to ready, so the loop dispatches the node.
func (c *Core) resume(ctx context.Context, id api.TicketID, outcome graph.Outcome, text string) error {
	st, ok := c.stages[id]
	if !ok || !c.parked[id] {
		return fmt.Errorf("ticket %s is not waiting on plan approval", id)
	}
	if h, _ := st.g.Node(st.node); h.Kind != graph.KindHuman {
		return fmt.Errorf("ticket %s is not waiting on plan approval", id)
	}
	next, err := st.g.Next(st.node, outcome)
	if err != nil {
		return err
	}
	if err := c.answer(ctx, id, st.node, outcome, text); err != nil {
		return err
	}
	if err := c.d.Tracker.SetPhase(ctx, id, api.PhaseReady); err != nil {
		return err
	}
	st.node, st.input = next, text
	delete(c.parked, id)
	return nil
}

func withPR(o api.Observation, pr int) api.Observation {
	if o.PR == 0 {
		o.PR = pr
	}
	return o
}

// record adds the finished node to the tutor's history: each build counts as an attempt on its tier.
func (st *stageRun) record(n graph.Node) {
	if !n.Verify {
		st.history = append(st.history, tutor.Attempt{Tier: st.tier})
	}
}

// approvalSchema is what an answer to a plan-approval interrupt must satisfy.
const approvalSchema = `{"type":"object","properties":{"outcome":{"enum":["pass","revise"]},"text":{"type":"string"}},"required":["outcome"]}`

func approvalThread(id api.TicketID, node string) string { return string(id) + "/" + node }

// raise stores the plan-approval wait of a human node as an interrupt; without Deps.Interrupts it does nothing.
func (c *Core) raise(ctx context.Context, id api.TicketID, node string) {
	if c.d.Interrupts == nil {
		return
	}
	payload, _ := json.Marshal(map[string]string{"ticket": string(id), "node": node})
	_, err := c.d.Interrupts.Task(approvalThread(id, node)).Interrupt(ctx, payload, json.RawMessage(approvalSchema))
	var p *interrupt.Pending
	if err != nil && !errors.As(err, &p) {
		c.report(err)
	}
}

// answer resumes the stored interrupt with the person's verdict. A value the schema rejects, or a
// store failure, stops the resume so the ticket stays parked.
func (c *Core) answer(ctx context.Context, id api.TicketID, node string, outcome graph.Outcome, text string) error {
	if c.d.Interrupts == nil {
		return nil
	}
	thread := approvalThread(id, node)
	value, _ := json.Marshal(map[string]string{"outcome": string(outcome), "text": text})
	if err := c.d.Interrupts.Resume(ctx, thread, value); err != nil && !errors.Is(err, interrupt.ErrNothingPending) {
		return err
	}
	return c.d.Interrupts.Done(ctx, thread)
}
