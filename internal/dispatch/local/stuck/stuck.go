// Ported from OpenHands/software-agent-sdk@10be259 openhands-sdk/openhands/sdk/conversation/stuck_detector.py

// Package stuck watches the stream-json events of a `claude -p` run and reports when the agent is
// looping: a nudge verdict on the first hit of a stall, an abort on the next hit before the agent
// makes progress. A different action after a nudge is progress and re-arms the nudge. The package
// only returns verdicts; whether a nudge reaches the agent is the caller's business.
package stuck

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

// Window is how many recent events are scanned for a loop.
const Window = 20

// historyCap bounds what is kept, so the action-error streak can look past the window.
const historyCap = 64

// Thresholds are the repeat counts that make a pattern a loop.
type Thresholds struct {
	ActionObservation, ActionError, Monologue, Alternating int
}

// DefaultThresholds are the upstream values 4, 3, 3 and 6.
var DefaultThresholds = Thresholds{ActionObservation: 4, ActionError: 3, Monologue: 3, Alternating: 6}

// Pattern names the loop a verdict is about.
type Pattern string

// The loop patterns. Each is one scenario of the upstream detector.
const (
	ActionObservation Pattern = "action-observation"
	ActionError       Pattern = "action-error"
	Monologue         Pattern = "monologue"
	Alternating       Pattern = "alternating"
	Compaction        Pattern = "compaction"
	ErrorRun          Pattern = "error-run"
)

// Kind is what the caller should do.
type Kind int

// The verdict kinds.
const (
	Continue Kind = iota
	Nudge
	Abort
)

// Verdict is the guard's answer for one event.
type Verdict struct {
	Kind    Kind
	Pattern Pattern
	Message string // the nudge text, or the reason for the abort
}

type evKind int

const (
	kAction evKind = iota
	kObs
	kErr
	kAgentMsg
	kUserMsg
	kCompaction
)

// event is one stream-json item in the shape the detector compares.
type event struct {
	seq     int
	kind    evKind
	respID  string // action: the model response that made the call
	toolID  string // action and observation: tool_use_id
	name    string // action and observation: tool name
	content string // action: canonical arguments; observation: result text; message: text
}

// eq ignores ids, like the upstream _event_eq. An action's thought is not compared, because
// stream-json delivers it as a separate line that varies between repeats.
func (e event) eq(o event) bool {
	return e.kind == o.kind && e.name == o.name && e.content == o.content
}

// Guard is the detector for one run. It is not safe for concurrent use.
type Guard struct {
	th          Thresholds
	hist        []event
	seq         int
	names       map[string]string // tool_use_id to tool name
	resumedAt   int               // only events after this seq count, set when a nudge is issued
	nudged      bool
	nudgeAct    event // the last action when the nudge was issued; a different action is progress
	hasNudgeAct bool
	nudgedError string // tool_use_id of the error already nudged for
}

// New returns a Guard with the given thresholds.
func New(th Thresholds) *Guard { return &Guard{th: th, names: map[string]string{}} }

// Feed reads one line of stream-json and returns what to do. A line that is not a tool or
// message event returns Continue.
func (g *Guard) Feed(line []byte) Verdict {
	evs := g.parse(line)
	if len(evs) == 0 {
		return Verdict{}
	}
	for _, e := range evs {
		g.seq++
		e.seq = g.seq
		if g.nudged && e.kind == kAction && (!g.hasNudgeAct || !e.eq(g.nudgeAct)) {
			g.nudged = false // progress: the next stall gets its own nudge
		}
		g.hist = append(g.hist, e)
	}
	if len(g.hist) > historyCap {
		g.hist = append([]event(nil), g.hist[len(g.hist)-historyCap:]...)
	}
	return g.verdict()
}

type block struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Input     json.RawMessage `json:"input"`
	ToolUseID string          `json:"tool_use_id"`
	Content   json.RawMessage `json:"content"`
	IsError   bool            `json:"is_error"`
}

func (g *Guard) parse(line []byte) []event {
	var l struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Message struct {
			ID      string          `json:"id"`
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal(line, &l) != nil {
		return nil
	}
	if l.Type == "system" && l.Subtype == "compact_boundary" {
		return []event{{kind: kCompaction}}
	}
	if l.Type != "assistant" && l.Type != "user" {
		return nil
	}
	var blocks []block
	if json.Unmarshal(l.Message.Content, &blocks) != nil {
		var s string // a plain string is a text message
		if json.Unmarshal(l.Message.Content, &s) != nil || s == "" {
			return nil
		}
		blocks = []block{{Type: "text", Text: s}}
	}
	var out []event
	for _, b := range blocks {
		switch {
		case b.Type == "tool_use":
			g.names[b.ID] = b.Name
			out = append(out, event{kind: kAction, respID: l.Message.ID, toolID: b.ID, name: b.Name, content: canonical(b.Input)})
		case b.Type == "tool_result":
			k := kObs
			if b.IsError {
				k = kErr
			}
			out = append(out, event{kind: k, toolID: b.ToolUseID, name: g.names[b.ToolUseID], content: resultText(b.Content)})
		case b.Type == "text" && l.Type == "assistant":
			out = append(out, event{kind: kAgentMsg, content: b.Text})
		case b.Type == "text":
			out = append(out, event{kind: kUserMsg, content: b.Text})
		}
	}
	return out
}

// canonical re-encodes JSON so key order and spacing do not matter.
func canonical(raw json.RawMessage) string {
	var v any
	if json.Unmarshal(raw, &v) != nil {
		return string(bytes.TrimSpace(raw))
	}
	b, _ := json.Marshal(v) // sorts map keys
	return string(b)
}

// resultText is a tool_result's content: a string, or a list of text blocks.
func resultText(raw json.RawMessage) string {
	var s string
	if json.Unmarshal(raw, &s) == nil {
		return s
	}
	var bs []block
	if json.Unmarshal(raw, &bs) != nil {
		return string(raw)
	}
	var sb strings.Builder
	for _, b := range bs {
		sb.WriteString(b.Text)
	}
	return sb.String()
}

// window is the last limit events, after the last user message and after the last nudge.
func (g *Guard) window(limit int) []event {
	evs := g.hist
	if len(evs) > limit {
		evs = evs[len(evs)-limit:]
	}
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].kind == kUserMsg {
			evs = evs[i+1:]
			break
		}
	}
	for i, e := range evs {
		if e.seq > g.resumedAt {
			return evs[i:]
		}
	}
	return nil
}

func (g *Guard) verdict() Verdict {
	evs := g.window(Window)
	acts, obs := collect(evs, len(evs))
	// Scenario 2 has its own window and nudges at the threshold, before it aborts above it.
	acts2, obs2 := g.actionErrorPairs()
	streak := g.errorStreak(acts2, obs2)
	if streak > g.th.ActionError {
		return Verdict{Kind: Abort, Pattern: ActionError, Message: fmt.Sprintf("%s failed the same way %d times in a row", acts2[0].name, streak)}
	}
	if streak == g.th.ActionError && acts2[0].toolID != g.nudgedError {
		g.nudgedError, g.nudged = acts2[0].toolID, true
		g.nudgeAct, g.hasNudgeAct = acts2[0], true
		return Verdict{Kind: Nudge, Pattern: ActionError, Message: fmt.Sprintf("You've called `%s` with the same arguments %d times in a row and gotten the same error each time. Repeating the exact same call again will not work. Review the error message and either correct the arguments or try a different approach.", acts2[0].name, streak)}
	}
	if p := g.pattern(evs, acts, obs); p != "" {
		if g.nudged {
			return Verdict{Kind: Abort, Pattern: p, Message: "stuck in a " + string(p) + " loop after a nudge"}
		}
		g.nudged, g.resumedAt = true, g.seq
		g.nudgeAct, g.hasNudgeAct = event{}, false
		if len(acts) > 0 {
			g.nudgeAct, g.hasNudgeAct = acts[0], true
		}
		return Verdict{Kind: Nudge, Pattern: p, Message: "You appear to be stuck in a " + string(p) + " loop. Stop repeating yourself and try a different approach."}
	}
	return Verdict{}
}

// pattern is the first of scenarios 1, 3, 4 and 5 that matches the window, or "".
func (g *Guard) pattern(evs, acts, obs []event) Pattern {
	t := g.th
	if len(evs) < min(t.ActionObservation, t.ActionError, t.Monologue) {
		return ""
	}
	switch {
	case allEq(acts, t.ActionObservation) && allEq(obs, t.ActionObservation):
		return ActionObservation
	case g.monologue(evs):
		return Monologue
	case len(evs) >= t.Alternating && alternating(evs, t.Alternating):
		return Alternating
	case len(evs) >= 10 && g.compaction(evs):
		return Compaction
	case g.errorRun(evs):
		return ErrorRun
	}
	return ""
}

// collect is the last n actions and n observations, most recent first.
func collect(evs []event, n int) (acts, obs []event) {
	for i := len(evs) - 1; i >= 0; i-- {
		e := evs[i]
		switch {
		case e.kind == kAction && len(acts) < n:
			acts = append(acts, e)
		case (e.kind == kObs || e.kind == kErr) && len(obs) < n:
			obs = append(obs, e)
		}
		if len(acts) >= n && len(obs) >= n {
			break
		}
	}
	return acts, obs
}

// allEq reports whether the first n of es exist and equal the first one.
func allEq(es []event, n int) bool {
	if len(es) < n {
		return false
	}
	for _, e := range es[:n] {
		if !es[0].eq(e) {
			return false
		}
	}
	return true
}

// actionErrorPairs widens the window by what parallel calls add, as upstream does.
func (g *Guard) actionErrorPairs() (acts, obs []event) {
	limit := Window
	for {
		evs := g.window(limit)
		acts, obs = collect(evs, len(evs))
		widths := map[string]int{}
		widest := 1
		for _, a := range acts {
			widths[a.respID]++
			widest = max(widest, widths[a.respID])
		}
		needed := Window + 2*(widest-1)*(g.th.ActionError+1)
		if needed <= limit || limit >= historyCap {
			return acts, obs
		}
		limit = min(needed, historyCap)
	}
}

// errorStreak counts the trailing responses that repeat one failing action.
func (g *Guard) errorStreak(acts, obs []event) int {
	if len(acts) == 0 || len(obs) == 0 {
		return 0
	}
	rest := append([]event(nil), obs...)
	streak, counted := 0, ""
	for _, a := range acts {
		i := -1
		for j, o := range rest {
			if o.toolID == a.toolID {
				i = j
				break
			}
		}
		if i < 0 || rest[i].kind != kErr || !acts[0].eq(a) {
			break
		}
		rest = append(rest[:i], rest[i+1:]...)
		if a.respID != counted { // parallel calls are one attempt
			counted = a.respID
			streak++
		}
	}
	return streak
}

// monologue is scenario 3: the newest events are all agent messages.
func (g *Guard) monologue(evs []event) bool {
	n := 0
	for i := len(evs) - 1; i >= 0; i-- {
		switch evs[i].kind {
		case kAgentMsg:
			n++
		case kCompaction:
		default:
			return n >= g.th.Monologue
		}
	}
	return n >= g.th.Monologue
}

// alternating is scenario 4: actions and observations repeat with period two.
func alternating(evs []event, n int) bool {
	acts, obs := collect(evs, n)
	if len(acts) != n || len(obs) != n {
		return false
	}
	for i := 0; i < n-2; i++ {
		if !acts[i].eq(acts[i+2]) || !obs[i].eq(obs[i+2]) {
			return false
		}
	}
	return true
}

// compaction is scenario 5. Upstream leaves it as a stub; here it is the newest events being
// nothing but context compactions, as many as the monologue threshold.
func (g *Guard) compaction(evs []event) bool {
	n := 0
	for i := len(evs) - 1; i >= 0 && evs[i].kind == kCompaction; i-- {
		n++
	}
	return n >= g.th.Monologue
}

// errorWindow is how many of the newest observations the error run looks at.
const errorWindow = 8

// errorRun is the newest observation being an error, with at least ActionError errors among the
// last errorWindow observations that came from more than one distinct call. One repeated call
// belongs to scenario 2. Ported from go/k9-stall internal/dispatch/stall/stall.go, which counted
// errors whatever the calls were.
func (g *Guard) errorRun(evs []event) bool {
	_, obs := collect(evs, errorWindow)
	if len(obs) == 0 || obs[0].kind != kErr {
		return false
	}
	calls := map[string]string{} // tool_use_id to the call's name and arguments
	for _, e := range evs {
		if e.kind == kAction {
			calls[e.toolID] = e.name + "\x00" + e.content
		}
	}
	n, distinct := 0, map[string]bool{}
	for _, o := range obs {
		if o.kind == kErr {
			n++
			distinct[calls[o.toolID]] = true
		}
	}
	return n >= g.th.ActionError && len(distinct) > 1
}
