package core

import (
	"context"
	"encoding/json"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/graph"
	"github.com/KaaS-team/factory/internal/graph/checkpoint"
	"github.com/KaaS-team/factory/internal/tutor"
)

// Checkpointer is the part of *checkpoint.Store the stage engine uses.
type Checkpointer interface {
	Put(ctx context.Context, thread string, state, metadata []byte) (string, error)
	PutWrites(ctx context.Context, thread, checkpointID string, w checkpoint.Write) error
	Latest(ctx context.Context, thread string) (checkpoint.Checkpoint, bool, error)
}

// outcomeChannel is the write channel a finished node's result goes to.
const outcomeChannel = "outcome"

// stageState is a stageRun as saved; Node is empty once the workflow has ended.
type stageState struct {
	Workflow string
	Node     string
	Tier     string
	Base     int
	Fails    int
	PR       int
	History  []tutor.Attempt
	Input    string
}

// finished is the result of a node whose session ended, saved before the graph moves on.
type finished struct {
	Outcome  graph.Outcome
	Attempts int
}

// restore returns the ticket's stage: the one in memory, else the one the latest checkpoint holds, or
// nil when there is neither. A node whose result was saved but not yet acted on carries it in fin.
func (c *Core) restore(ctx context.Context, id api.TicketID) (*stageRun, error) {
	if st, ok := c.stages[id]; ok {
		return st, nil
	}
	if c.d.Stages == nil || c.d.Stages.Checkpoints == nil {
		return nil, nil
	}
	cp, ok, err := c.d.Stages.Checkpoints.Latest(ctx, string(id))
	if err != nil || !ok {
		return nil, err
	}
	var s stageState
	if err := json.Unmarshal(cp.State, &s); err != nil || s.Node == graph.End {
		return nil, err
	}
	g, err := c.d.Stages.Graph(s.Workflow)
	if err != nil {
		return nil, err
	}
	st := &stageRun{g: g, node: s.Node, tier: s.Tier, base: s.Base, fails: s.Fails, pr: s.PR, history: s.History, input: s.Input, wf: s.Workflow, saved: true}
	for _, w := range cp.Writes {
		var f finished
		if w.Task == s.Node && w.Channel == outcomeChannel && json.Unmarshal(w.Value, &f) == nil {
			st.fin = &f
		}
	}
	c.stages[id] = st
	return st, nil
}

// save checkpoints the stage with the node it now stands at (graph.End when the workflow is over).
func (c *Core) save(ctx context.Context, id api.TicketID, st *stageRun, node string) {
	if c.d.Stages.Checkpoints == nil {
		return
	}
	b, err := json.Marshal(stageState{st.wf, node, st.tier, st.base, st.fails, st.pr, st.history, st.input})
	if err == nil {
		_, err = c.d.Stages.Checkpoints.Put(ctx, string(id), b, nil)
	}
	c.report(err)
	st.fin, st.saved = nil, true
}

// saveWrite records that the stage's current node finished, against the checkpoint that holds it.
func (c *Core) saveWrite(ctx context.Context, id api.TicketID, st *stageRun, f finished) {
	if c.d.Stages.Checkpoints == nil {
		return
	}
	if !st.saved { // the node ran from the start of the graph; give the write a checkpoint to sit on
		c.save(ctx, id, st, st.node)
	}
	cp, _, err := c.d.Stages.Checkpoints.Latest(ctx, string(id))
	if err == nil {
		var b []byte
		if b, err = json.Marshal(f); err == nil {
			err = c.d.Stages.Checkpoints.PutWrites(ctx, string(id), cp.ID, checkpoint.Write{Task: st.node, Channel: outcomeChannel, Value: b})
		}
	}
	c.report(err)
}
