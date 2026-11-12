// Package mcp serves the factory to Claude Code over stdio, using the tool
// names of KaaS-team/factory-mcp. It reaches the core only through api.Control.
package mcp

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/internal/api"
)

// PlanInput is the input of the plan tool.
type PlanInput struct {
	Goal string `json:"goal" jsonschema:"what to plan"`
}

// ApprovePlanInput is the input of the approve_plan tool.
type ApprovePlanInput struct {
	PlanID string `json:"plan_id" jsonschema:"id of the plan to approve"`
}

// Handlers holds the optional tool implementations; a nil func makes its tool
// answer "not available in this build".
type Handlers struct {
	Plan          func(ctx context.Context, in PlanInput) (string, error)
	ApprovePlan   func(ctx context.Context, in ApprovePlanInput) (string, error)
	ExplainConfig func(ctx context.Context) (string, error)
	FirstRun      func(ctx context.Context) (string, error)
	Report        func(ctx context.Context) (string, error)
}

// Empty is the input of tools that take no arguments.
type Empty struct{}

// TicketInput names one ticket.
type TicketInput struct {
	Ticket string `json:"ticket" jsonschema:"ticket id"`
}

// SteerInput sends a message to a running ticket's session.
type SteerInput struct {
	Ticket  string `json:"ticket" jsonschema:"ticket id"`
	Message string `json:"message" jsonschema:"message for the session"`
}

// TextOutput is a plain text answer.
type TextOutput struct {
	Text string `json:"text"`
}

// OK is the answer of a mutating tool.
type OK struct {
	Ticket string `json:"ticket"`
	Done   string `json:"done"`
}

// SlotView is a board slot without usage, cost or budget.
type SlotView struct {
	Ticket   api.Ticket `json:"ticket"`
	Phase    api.Phase  `json:"phase"`
	Session  string     `json:"session,omitempty"`
	LastPush time.Time  `json:"last_push,omitempty"`
}

// BoardView is the board as MCP clients see it: no token counts, cost or model.
type BoardView struct {
	Slots      []SlotView     `json:"slots"`
	Ready      []api.Ticket   `json:"ready"`
	MergeQueue []api.TicketID `json:"merge_queue"`
	FiresLeft  int            `json:"fires_left"`
}

// TicketsOutput lists the tickets on the board.
type TicketsOutput struct {
	Tickets []api.Ticket `json:"tickets"`
}

// QueueOutput lists the merge queue.
type QueueOutput struct {
	MergeQueue []api.TicketID `json:"merge_queue"`
}

// EventView is an event without its free-form data.
type EventView struct {
	Time   time.Time    `json:"time"`
	Kind   string       `json:"kind"`
	Ticket api.TicketID `json:"ticket,omitempty"`
}

// TicketView is the ticket resource: the ticket, its phase and its events.
type TicketView struct {
	Ticket api.Ticket  `json:"ticket"`
	Phase  api.Phase   `json:"phase"`
	Events []EventView `json:"events"`
}

func boardView(b api.Board) BoardView {
	v := BoardView{Slots: []SlotView{}, Ready: nonNil(b.Ready), MergeQueue: nonNilIDs(b.MergeQueue), FiresLeft: b.FiresLeft}
	for _, s := range b.Slots {
		sv := SlotView{Ticket: s.Ticket, Phase: s.Phase, LastPush: s.LastPush}
		if s.Session != nil {
			sv.Session = s.Session.Key
		}
		v.Slots = append(v.Slots, sv)
	}
	return v
}

func nonNil(t []api.Ticket) []api.Ticket {
	if t == nil {
		return []api.Ticket{}
	}
	return t
}

func nonNilIDs(t []api.TicketID) []api.TicketID {
	if t == nil {
		return []api.TicketID{}
	}
	return t
}

func unavailable(name string) error {
	return fmt.Errorf("%s: not available in this build", name)
}

// textTool wraps an optional handler: nil answers a tool error naming the tool.
func textTool[In any](name string, h func(context.Context, In) (string, error)) sdk.ToolHandlerFor[In, TextOutput] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in In) (*sdk.CallToolResult, TextOutput, error) {
		if h == nil {
			return nil, TextOutput{}, unavailable(name)
		}
		s, err := h(ctx, in)
		return nil, TextOutput{Text: s}, err
	}
}

func noArg(h func(context.Context) (string, error)) func(context.Context, Empty) (string, error) {
	if h == nil {
		return nil
	}
	return func(ctx context.Context, _ Empty) (string, error) { return h(ctx) }
}

func act(name string, f func(context.Context, TicketInput) error) sdk.ToolHandlerFor[TicketInput, OK] {
	return func(ctx context.Context, _ *sdk.CallToolRequest, in TicketInput) (*sdk.CallToolResult, OK, error) {
		if err := f(ctx, in); err != nil {
			return nil, OK{}, fmt.Errorf("%s: %w", name, err)
		}
		return nil, OK{Ticket: in.Ticket, Done: name}, nil
	}
}

// NewServer returns an MCP server exposing the twelve factory tools and the
// factory://board and factory://ticket/{id} resources.
func NewServer(ctl api.Control, extra Handlers) *sdk.Server {
	s := sdk.NewServer(&sdk.Implementation{Name: "factory", Version: "v9"}, nil)

	sdk.AddTool(s, &sdk.Tool{Name: "plan", Description: "Plan a goal into tickets"}, textTool("plan", extra.Plan))
	sdk.AddTool(s, &sdk.Tool{Name: "approve_plan", Description: "Approve a plan so its tickets are filed"}, textTool("approve_plan", extra.ApprovePlan))
	sdk.AddTool(s, &sdk.Tool{Name: "explain_config", Description: "Explain the active configuration"}, textTool("explain_config", noArg(extra.ExplainConfig)))
	sdk.AddTool(s, &sdk.Tool{Name: "first_run", Description: "Walk through a first run"}, textTool("first_run", noArg(extra.FirstRun)))
	sdk.AddTool(s, &sdk.Tool{Name: "report", Description: "Report on finished work"}, textTool("report", noArg(extra.Report)))

	sdk.AddTool(s, &sdk.Tool{Name: "status", Description: "Show the board"},
		func(ctx context.Context, _ *sdk.CallToolRequest, _ Empty) (*sdk.CallToolResult, BoardView, error) {
			b, err := ctl.Board(ctx)
			return nil, boardView(b), err
		})
	sdk.AddTool(s, &sdk.Tool{Name: "list_tickets", Description: "List running and ready tickets"},
		func(ctx context.Context, _ *sdk.CallToolRequest, _ Empty) (*sdk.CallToolResult, TicketsOutput, error) {
			b, err := ctl.Board(ctx)
			out := TicketsOutput{Tickets: []api.Ticket{}}
			for _, sl := range b.Slots {
				out.Tickets = append(out.Tickets, sl.Ticket)
			}
			out.Tickets = append(out.Tickets, b.Ready...)
			return nil, out, err
		})
	sdk.AddTool(s, &sdk.Tool{Name: "queue", Description: "Show the merge queue"},
		func(ctx context.Context, _ *sdk.CallToolRequest, _ Empty) (*sdk.CallToolResult, QueueOutput, error) {
			b, err := ctl.Board(ctx)
			return nil, QueueOutput{MergeQueue: nonNilIDs(b.MergeQueue)}, err
		})

	sdk.AddTool(s, &sdk.Tool{Name: "dispatch", Description: "Dispatch a ready ticket"},
		act("dispatch", func(ctx context.Context, in TicketInput) error { return ctl.Dispatch(ctx, api.TicketID(in.Ticket)) }))
	sdk.AddTool(s, &sdk.Tool{Name: "cancel", Description: "Cancel a ticket's session"},
		act("cancel", func(ctx context.Context, in TicketInput) error { return ctl.Cancel(ctx, api.TicketID(in.Ticket)) }))
	sdk.AddTool(s, &sdk.Tool{Name: "retry", Description: "Retry a ticket"},
		act("retry", func(ctx context.Context, in TicketInput) error { return ctl.Retry(ctx, api.TicketID(in.Ticket)) }))
	sdk.AddTool(s, &sdk.Tool{Name: "steer", Description: "Send a message to a running ticket's session"},
		func(ctx context.Context, _ *sdk.CallToolRequest, in SteerInput) (*sdk.CallToolResult, OK, error) {
			if err := ctl.Steer(ctx, api.TicketID(in.Ticket), in.Message); err != nil {
				return nil, OK{}, fmt.Errorf("steer: %w", err)
			}
			return nil, OK{Ticket: in.Ticket, Done: "steer"}, nil
		})

	s.AddResource(&sdk.Resource{URI: "factory://board", Name: "board", MIMEType: "application/json", Description: "The factory board"},
		func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
			b, err := ctl.Board(ctx)
			if err != nil {
				return nil, err
			}
			return jsonResource(req.Params.URI, boardView(b))
		})
	s.AddResourceTemplate(&sdk.ResourceTemplate{URITemplate: "factory://ticket/{id}", Name: "ticket", MIMEType: "application/json", Description: "A ticket and its events"},
		func(ctx context.Context, req *sdk.ReadResourceRequest) (*sdk.ReadResourceResult, error) {
			return ticketResource(ctx, ctl, req.Params.URI)
		})
	return s
}

func jsonResource(uri string, v any) (*sdk.ReadResourceResult, error) {
	b, err := jsonIndent(v)
	if err != nil {
		return nil, err
	}
	return &sdk.ReadResourceResult{Contents: []*sdk.ResourceContents{{URI: uri, MIMEType: "application/json", Text: b}}}, nil
}

func ticketResource(ctx context.Context, ctl api.Control, uri string) (*sdk.ReadResourceResult, error) {
	id, ok := strings.CutPrefix(uri, "factory://ticket/")
	if !ok || id == "" {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	b, err := ctl.Board(ctx)
	if err != nil {
		return nil, err
	}
	v := TicketView{Events: []EventView{}}
	found := false
	for _, sl := range b.Slots {
		if string(sl.Ticket.ID) == id {
			v.Ticket, v.Phase, found = sl.Ticket, sl.Phase, true
		}
	}
	for _, t := range b.Ready {
		if !found && string(t.ID) == id {
			v.Ticket, v.Phase, found = t, api.PhaseReady, true
		}
	}
	if !found {
		return nil, sdk.ResourceNotFoundError(uri)
	}
	// Events is a live stream: take what is buffered, stop at close or a short idle.
	ectx, cancel := context.WithTimeout(ctx, 200*time.Millisecond)
	defer cancel()
	ch, err := ctl.Events(ectx)
	if err != nil {
		return nil, err
	}
loop:
	for {
		select {
		case e, open := <-ch:
			if !open {
				break loop
			}
			if string(e.Ticket) == id {
				v.Events = append(v.Events, EventView{Time: e.Time, Kind: e.Kind, Ticket: e.Ticket})
			}
		case <-ectx.Done():
			break loop
		}
	}
	return jsonResource(uri, v)
}

// Option configures NewCommand.
type Option func(*cmdConfig)

type cmdConfig struct {
	open func() (api.Control, Handlers, error)
}

// WithControl supplies the control plane and optional handlers the command serves.
func WithControl(open func() (api.Control, Handlers, error)) Option {
	return func(c *cmdConfig) { c.open = open }
}

// NewCommand returns `factory mcp`, which serves over stdio. Without
// WithControl it fails, since the command cannot reach a core by itself.
func NewCommand(opts ...Option) *cobra.Command {
	var cfg cmdConfig
	for _, o := range opts {
		o(&cfg)
	}
	return &cobra.Command{
		Use:   "mcp",
		Short: "Serve the factory to Claude Code over stdio (MCP)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			if cfg.open == nil {
				return errors.New("mcp: no control plane wired in this build")
			}
			c, h, err := cfg.open()
			if err != nil {
				return err
			}
			return NewServer(c, h).Run(cmd.Context(), &sdk.StdioTransport{})
		},
	}
}
