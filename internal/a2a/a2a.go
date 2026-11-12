// Package a2a serves the factory as an A2A agent: another agent sends a request
// as text, the factory files a ticket labelled ready, and the task carries the
// ticket id in its metadata. The task state is read from the ticket's phase on every get.
//
// The wire format is A2A v1 JSON-RPC, served by the official SDK
// github.com/a2aproject/a2a-go/v2 (Apache-2.0) behind an AgentExecutor. A request
// without an A2A-Version 1.x header is served as v0.3 through the SDK's compat handler.
package a2a

import (
	"context"
	"crypto/ecdsa"
	"fmt"
	"iter"
	"net/http"
	"strings"
	"time"

	sdk "github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	"github.com/a2aproject/a2a-go/v2/a2asrv"
	"github.com/a2aproject/a2a-go/v2/a2asrv/taskstore"

	"github.com/KaaS-team/factory/internal/api"
)

// LabelReady is the label a filed ticket carries so the factory picks it up.
const LabelReady = "factory:ready"

// MetaTicket is the task metadata key that holds the id of the ticket a task follows.
const MetaTicket = "ticket"

// Filer files one ticket and returns its id. api.Tracker has no way to create one
// (the GitHub tracker's Create satisfies this).
type Filer interface {
	Create(ctx context.Context, t api.Ticket) (api.TicketID, error)
}

// PhaseReader reports a ticket's current phase. api.Tracker can set a phase but not read it.
type PhaseReader interface {
	Phase(ctx context.Context, id api.TicketID) (api.Phase, error)
}

// Deps is everything the A2A server reaches. Token is the bearer token and URL the public base URL.
// Key signs the agent card (a fresh key is made when nil), Audit receives one row per call (none when nil),
// and Poll is how often a task re-reads its ticket's phase (5 seconds when zero).
type Deps struct {
	Tracker  api.Tracker
	Filer    Filer
	Phases   PhaseReader
	Observer api.Observer
	Audit    Auditor
	Key      *ecdsa.PrivateKey
	Token    string
	URL      string
	Poll     time.Duration
}

// phaseState maps every phase to the A2A task state it shows as.
var phaseState = map[api.Phase]sdk.TaskState{
	api.PhaseReady:      sdk.TaskStateSubmitted,
	api.PhaseClaimed:    sdk.TaskStateSubmitted,
	api.PhaseRunning:    sdk.TaskStateWorking,
	api.PhaseStalled:    sdk.TaskStateWorking,
	api.PhaseRetryQueue: sdk.TaskStateWorking,
	api.PhaseDone:       sdk.TaskStateWorking,
	api.PhaseQueued:     sdk.TaskStateWorking,
	api.PhaseMerged:     sdk.TaskStateCompleted,
	api.PhaseNeedsHuman: sdk.TaskStateInputRequired,
	api.PhaseCanceled:   sdk.TaskStateCanceled,
}

func stateForPhase(p api.Phase) (sdk.TaskState, bool) {
	s, ok := phaseState[p]
	return s, ok
}

// agentCard is the card served at /.well-known/agent-card.json, before signing.
func agentCard(url string) *sdk.AgentCard {
	return &sdk.AgentCard{
		Name:        "factory",
		Description: "Turns a request into a merged pull request.",
		Version:     "1",
		SupportedInterfaces: []*sdk.AgentInterface{
			{URL: url, ProtocolBinding: sdk.TransportProtocolJSONRPC, ProtocolVersion: sdk.Version},
			{URL: url, ProtocolBinding: sdk.TransportProtocolJSONRPC, ProtocolVersion: a2av0.Version},
		},
		Capabilities:       sdk.AgentCapabilities{Streaming: true},
		DefaultInputModes:  []string{"text/plain"},
		DefaultOutputModes: []string{"text/plain"},
		SecuritySchemes: sdk.NamedSecuritySchemes{
			"bearer": sdk.HTTPAuthSecurityScheme{Scheme: "Bearer"},
		},
		SecurityRequirements: sdk.SecurityRequirementsOptions{{"bearer": {}}},
		Skills: []sdk.AgentSkill{{
			ID:          "implement",
			Name:        "implement",
			Description: "Turn a request into a merged PR. Input is text; the output artifact is the PR URL.",
			Tags:        []string{"code"},
			InputModes:  []string{"text/plain"},
			OutputModes: []string{"text/plain"},
		}},
	}
}

// executor is the a2asrv.AgentExecutor over the tracker: it files a ticket for a new task and follows
// the ticket's phase until the task ends or needs a human. The SDK waits on an execution until it
// reaches such a state, so an execution never ends before.
type executor struct {
	deps Deps
}

var _ a2asrv.AgentExecutor = (*executor)(nil)

// Execute files one ticket for the message and reports the task, then emits an update each time the
// ticket's phase maps to a new state. A client that sets returnImmediately gets the submitted task at once.
func (e *executor) Execute(ctx context.Context, ec *a2asrv.ExecutorContext) iter.Seq2[sdk.Event, error] {
	return func(yield func(sdk.Event, error) bool) {
		if ec.StoredTask != nil {
			yield(nil, fmt.Errorf("%w: a follow-up message to a task is not supported", sdk.ErrUnsupportedOperation))
			return
		}
		body := textOf(ec.Message)
		if body == "" {
			yield(nil, fmt.Errorf("%w: the request needs text", sdk.ErrInvalidParams))
			return
		}
		id, err := e.deps.Filer.Create(ctx, api.Ticket{Title: titleOf(body), Body: body, Labels: []string{LabelReady}})
		if err != nil {
			yield(nil, fmt.Errorf("file ticket: %w", err))
			return
		}
		task := sdk.NewSubmittedTask(ec, ec.Message)
		task.Metadata = map[string]any{MetaTicket: string(id)}
		if !yield(task, nil) {
			return
		}
		e.follow(ctx, ec, id, yield)
	}
}

// follow reads the phase from the store (not the tracker, which is a remote API) and emits a status update whenever the ticket's state changes, and the pull request as an
// artifact before the task completes. It returns once the task is terminal or needs input.
func (e *executor) follow(ctx context.Context, ec *a2asrv.ExecutorContext, id api.TicketID, yield func(sdk.Event, error) bool) {
	poll := e.deps.Poll
	if poll <= 0 {
		poll = 5 * time.Second
	}
	tick := time.NewTicker(poll)
	defer tick.Stop()
	last := sdk.TaskStateSubmitted
	for {
		select {
		case <-ctx.Done():
			return
		case <-tick.C:
		}
		phase, err := e.deps.Phases.Phase(ctx, id)
		if err != nil {
			continue // a failed read is retried on the next tick
		}
		state, ok := stateForPhase(phase)
		if !ok {
			yield(nil, fmt.Errorf("ticket %s is in unknown phase %q", id, phase))
			return
		}
		if state == last {
			continue
		}
		last = state
		if state == sdk.TaskStateCompleted {
			if url := e.prURL(ctx, id); url != "" {
				if !yield(sdk.NewArtifactEvent(ec, sdk.NewTextPart(url)), nil) {
					return
				}
			}
		}
		if !yield(sdk.NewStatusUpdateEvent(ec, state, nil), nil) {
			return
		}
		if state.Terminal() || state == sdk.TaskStateInputRequired {
			return
		}
	}
}

// Cancel refuses: the factory has no way to stop a filed ticket from here.
func (*executor) Cancel(context.Context, *a2asrv.ExecutorContext) iter.Seq2[sdk.Event, error] {
	return func(yield func(sdk.Event, error) bool) { yield(nil, sdk.ErrUnsupportedOperation) }
}

// state is the A2A state of a ticket from its current phase.
func (e *executor) state(ctx context.Context, id api.TicketID) (sdk.TaskState, error) {
	if _, err := e.deps.Tracker.Get(ctx, id); err != nil {
		return "", sdk.ErrTaskNotFound
	}
	phase, err := e.deps.Phases.Phase(ctx, id)
	if err != nil {
		return "", fmt.Errorf("read phase: %w", err)
	}
	state, ok := stateForPhase(phase)
	if !ok {
		return "", fmt.Errorf("ticket %s is in unknown phase %q", id, phase)
	}
	return state, nil
}

// prURL is the pull request link for a ticket, or "" when the observer knows no PR.
func (e *executor) prURL(ctx context.Context, id api.TicketID) string {
	tk, err := e.deps.Tracker.Get(ctx, id)
	if err != nil || e.deps.Observer == nil || tk.Repo == "" {
		return ""
	}
	var o api.Observation
	if l, ok := e.deps.Observer.(api.LatestObserver); ok {
		o, err = l.Latest(ctx, id)
	} else {
		o, err = e.deps.Observer.Observe(ctx, id, 1)
	}
	if err != nil || o.PR == 0 {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/pull/%d", tk.Repo, o.PR)
}

// liveStore keeps tasks in the SDK's memory store but answers every get from the ticket's phase,
// so a task shows the phase the tracker has now, not the one it had when the last event was stored.
type liveStore struct {
	taskstore.Store
	e *executor
}

func (s liveStore) Get(ctx context.Context, id sdk.TaskID) (*taskstore.StoredTask, error) {
	st, err := s.Store.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	ticket, _ := st.Task.Metadata[MetaTicket].(string)
	if ticket == "" {
		return st, nil
	}
	state, err := s.e.state(ctx, api.TicketID(ticket))
	if err != nil {
		return nil, err
	}
	t := *st.Task
	t.Status = sdk.TaskStatus{State: state}
	if state == sdk.TaskStateCompleted && len(t.Artifacts) == 0 {
		if url := s.e.prURL(ctx, api.TicketID(ticket)); url != "" {
			t.Artifacts = []*sdk.Artifact{{ID: "pr", Name: "pull request", Parts: sdk.ContentParts{sdk.NewTextPart(url)}}}
		}
	}
	return &taskstore.StoredTask{Task: &t, Version: st.Version, User: st.User}, nil
}

// textOf is the trimmed text of a message, its text parts joined by newlines.
func textOf(m *sdk.Message) string {
	if m == nil {
		return ""
	}
	var text []string
	for _, p := range m.Parts {
		text = append(text, p.Text())
	}
	return strings.TrimSpace(strings.Join(text, "\n"))
}

// titleOf is the first line of a request, cut to 80 runes.
func titleOf(body string) string {
	line, _, _ := strings.Cut(body, "\n")
	line = strings.TrimSpace(line)
	if r := []rune(line); len(r) > 80 {
		line = string(r[:80])
	}
	return line
}

// NewHandler serves the signed agent card and the key set that verifies it (both public), and the
// JSON-RPC endpoint at / (bearer token required). With no Token set every JSON-RPC request is refused
// with 401. A2A-Version 1.x requests get v1, any other gets v0.3.
func NewHandler(deps Deps) (http.Handler, error) {
	signer, jwks, err := newSigning(deps.Key, strings.TrimRight(deps.URL, "/")+jwksPath)
	if err != nil {
		return nil, err
	}
	e := &executor{deps: deps}
	opts := []a2asrv.RequestHandlerOption{
		a2asrv.WithTaskStore(liveStore{Store: taskstore.NewInMemory(nil), e: e}),
	}
	if deps.Audit != nil {
		opts = append(opts, a2asrv.WithCallInterceptors(&auditor{sink: deps.Audit}))
	}
	h := a2asrv.NewHandler(e, opts...)
	v1, v03 := a2asrv.NewJSONRPCHandler(h), a2av0.NewJSONRPCHandler(h)
	card := a2asrv.NewSignedCardProducer(a2asrv.AgentCardProducerFn(func(context.Context) (*sdk.AgentCard, error) {
		return agentCard(deps.URL), nil
	}), signer)
	mux := http.NewServeMux()
	mux.Handle("GET /.well-known/agent-card.json", a2asrv.NewAgentCardHandler(card))
	mux.Handle("GET "+jwksPath, jwks)
	mux.Handle("/", bearer(deps.Token, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.Header.Get(sdk.SvcParamVersion), "1") {
			v1.ServeHTTP(w, r)
			return
		}
		v03.ServeHTTP(w, r)
	})))
	return mux, nil
}
