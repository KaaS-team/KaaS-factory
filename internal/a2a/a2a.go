// Package a2a serves the factory as an A2A agent: another agent sends a request
// as text, the factory files a ticket labelled ready, and the task id is the
// ticket id. The task state is read from the ticket's phase on every get.
//
// The wire format is A2A v0.3 JSON-RPC (message/send, tasks/get), served by the
// official SDK github.com/a2aproject/a2a-go/v2 (Apache-2.0).
package a2a

import (
	"context"
	"fmt"
	"iter"
	"net/http"
	"strings"

	sdk "github.com/a2aproject/a2a-go/v2/a2a"
	"github.com/a2aproject/a2a-go/v2/a2acompat/a2av0"
	"github.com/a2aproject/a2a-go/v2/a2asrv"

	"github.com/KaaS-team/factory/internal/api"
)

// LabelReady is the label a filed ticket carries so the factory picks it up.
const LabelReady = "factory:ready"

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
type Deps struct {
	Tracker  api.Tracker
	Filer    Filer
	Phases   PhaseReader
	Observer api.Observer
	Token    string
	URL      string
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

// agentCard is the card served at /.well-known/agent-card.json.
func agentCard(url string) *sdk.AgentCard {
	return &sdk.AgentCard{
		Name:        "factory",
		Description: "Turns a request into a merged pull request.",
		Version:     "1",
		SupportedInterfaces: []*sdk.AgentInterface{
			{URL: url, ProtocolBinding: sdk.TransportProtocolJSONRPC, ProtocolVersion: a2av0.Version},
		},
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

// server implements a2asrv.RequestHandler over the tracker. It serves message/send and tasks/get;
// the other methods return the SDK's unsupported-operation or push-notification-not-supported error.
type server struct {
	deps Deps
}

var _ a2asrv.RequestHandler = (*server)(nil)

func (s *server) SendMessage(ctx context.Context, req *sdk.SendMessageRequest) (sdk.SendMessageResult, error) {
	if req.Message == nil {
		return nil, fmt.Errorf("%w: message is required", sdk.ErrInvalidParams)
	}
	var text []string
	for _, p := range req.Message.Parts {
		text = append(text, p.Text())
	}
	body := strings.TrimSpace(strings.Join(text, "\n"))
	if body == "" {
		return nil, fmt.Errorf("%w: the request needs text", sdk.ErrInvalidParams)
	}
	id, err := s.deps.Filer.Create(ctx, api.Ticket{Title: titleOf(body), Body: body, Labels: []string{LabelReady}})
	if err != nil {
		return nil, fmt.Errorf("file ticket: %w", err)
	}
	return s.task(ctx, id)
}

func (s *server) GetTask(ctx context.Context, req *sdk.GetTaskRequest) (*sdk.Task, error) {
	return s.task(ctx, api.TicketID(req.ID))
}

// task builds the A2A task for a ticket from its current phase.
func (s *server) task(ctx context.Context, id api.TicketID) (*sdk.Task, error) {
	tk, err := s.deps.Tracker.Get(ctx, id)
	if err != nil {
		return nil, sdk.ErrTaskNotFound
	}
	phase, err := s.deps.Phases.Phase(ctx, id)
	if err != nil {
		return nil, fmt.Errorf("read phase: %w", err)
	}
	state, ok := stateForPhase(phase)
	if !ok {
		return nil, fmt.Errorf("ticket %s is in unknown phase %q", id, phase)
	}
	t := &sdk.Task{ID: sdk.TaskID(id), ContextID: "ticket-" + string(id), Status: sdk.TaskStatus{State: state}}
	if state == sdk.TaskStateCompleted {
		if url := s.prURL(ctx, tk); url != "" {
			t.Artifacts = []*sdk.Artifact{{ID: "pr", Name: "pull request", Parts: sdk.ContentParts{sdk.NewTextPart(url)}}}
		}
	}
	return t, nil
}

// prURL is the pull request link for a ticket, or "" when the observer knows no PR.
func (s *server) prURL(ctx context.Context, tk api.Ticket) string {
	if s.deps.Observer == nil || tk.Repo == "" {
		return ""
	}
	var o api.Observation
	var err error
	if l, ok := s.deps.Observer.(api.LatestObserver); ok {
		o, err = l.Latest(ctx, tk.ID)
	} else {
		o, err = s.deps.Observer.Observe(ctx, tk.ID, 1)
	}
	if err != nil || o.PR == 0 {
		return ""
	}
	return fmt.Sprintf("https://github.com/%s/pull/%d", tk.Repo, o.PR)
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

func (*server) ListTasks(context.Context, *sdk.ListTasksRequest) (*sdk.ListTasksResponse, error) {
	return nil, sdk.ErrUnsupportedOperation
}

func (*server) CancelTask(context.Context, *sdk.CancelTaskRequest) (*sdk.Task, error) {
	return nil, sdk.ErrUnsupportedOperation
}

func unsupported(yield func(sdk.Event, error) bool) { yield(nil, sdk.ErrUnsupportedOperation) }

func (*server) SubscribeToTask(context.Context, *sdk.SubscribeToTaskRequest) iter.Seq2[sdk.Event, error] {
	return unsupported
}

func (*server) SendStreamingMessage(context.Context, *sdk.SendMessageRequest) iter.Seq2[sdk.Event, error] {
	return unsupported
}

func (*server) GetTaskPushConfig(context.Context, *sdk.GetTaskPushConfigRequest) (*sdk.PushConfig, error) {
	return nil, sdk.ErrPushNotificationNotSupported
}

func (*server) ListTaskPushConfigs(context.Context, *sdk.ListTaskPushConfigRequest) (*sdk.ListTaskPushConfigResponse, error) {
	return nil, sdk.ErrPushNotificationNotSupported
}

func (*server) CreateTaskPushConfig(context.Context, *sdk.PushConfig) (*sdk.PushConfig, error) {
	return nil, sdk.ErrPushNotificationNotSupported
}

func (*server) DeleteTaskPushConfig(context.Context, *sdk.DeleteTaskPushConfigRequest) error {
	return sdk.ErrPushNotificationNotSupported
}

func (*server) GetExtendedAgentCard(context.Context, *sdk.GetExtendedAgentCardRequest) (*sdk.AgentCard, error) {
	return nil, sdk.ErrUnsupportedOperation
}

// NewHandler serves the agent card (public) and the JSON-RPC endpoint at / (bearer token required).
// With no Token set every JSON-RPC request is refused with 401.
func NewHandler(deps Deps) http.Handler {
	mux := http.NewServeMux()
	mux.Handle("GET /.well-known/agent-card.json", a2asrv.NewAgentCardHandler(a2av0.NewStaticAgentCardProducer(agentCard(deps.URL))))
	mux.Handle("/", bearer(deps.Token, a2av0.NewJSONRPCHandler(&server{deps: deps})))
	return mux
}
