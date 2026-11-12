// Package tui is the terminal board, a client of api.Control only.
package tui

import (
	"context"
	"fmt"
	"reflect"
	"sort"
	"strings"
	"time"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/KaaS-team/factory/internal/api"
)

type screen int

const (
	screenBoard screen = iota
	screenWaves
	screenQueue
	screenTimeline
)

func (s screen) String() string { return [...]string{"board", "waves", "queue", "timeline"}[s] }

type mode int

const (
	modeNormal mode = iota
	modeSteer
	modeConfirmCancel
)

const (
	defaultWidth  = 100
	defaultHeight = 30
	maxTimeline   = 200
	// warnAbove is the share of budget above which a usage bar warns.
	warnAbove = 0.80
	// warnMarker follows the percentage of a bar in the warning style.
	warnMarker = "!"
)

var (
	styleWarn     = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("1"))
	styleStalled  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("3"))
	styleSelected = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6"))
	styleDim      = lipgloss.NewStyle().Faint(true)
)

// Model is the board's Bubble Tea model. It reads state from api.Control and its event stream.
type Model struct {
	ctl    api.Control
	ctx    context.Context
	cancel context.CancelFunc
	now    func() time.Time

	width, height int
	board         api.Board
	stalled       map[api.TicketID]bool
	events        <-chan api.Event
	timelines     map[api.TicketID][]api.Event
	loaded        map[api.TicketID]bool // history asked for
	reasons       map[api.TicketID]string
	gate          api.Event // newest gate event

	screen  screen
	mode    mode
	cursor  int
	tlID    api.TicketID
	input   textinput.Model
	pending api.TicketID
	status  string
}

type (
	boardMsg  api.Board
	eventsMsg struct{ ch <-chan api.Event }
	eventMsg  api.Event
	errMsg    struct{ err error }
	doneMsg   struct{ note string }
	// historyMsg is a ticket's past events from an api.Historian.
	historyMsg struct {
		id  api.TicketID
		evs []api.Event
	}
)

// New returns the board model for ctl.
func New(ctl api.Control) tea.Model {
	ctx, cancel := context.WithCancel(context.Background())
	in := textinput.New()
	in.Prompt = "steer> "
	return &Model{
		ctl: ctl, ctx: ctx, cancel: cancel, now: time.Now,
		width: defaultWidth, height: defaultHeight,
		stalled:   map[api.TicketID]bool{},
		timelines: map[api.TicketID][]api.Event{},
		loaded:    map[api.TicketID]bool{},
		reasons:   map[api.TicketID]string{},
		input:     in,
	}
}

// Init loads the board once and opens the event stream.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.loadBoard(), m.subscribe())
}

func (m *Model) loadBoard() tea.Cmd {
	return func() tea.Msg {
		b, err := m.ctl.Board(m.ctx)
		if err != nil {
			return errMsg{err}
		}
		return boardMsg(b)
	}
}

func (m *Model) subscribe() tea.Cmd {
	return func() tea.Msg {
		ch, err := m.ctl.Events(m.ctx)
		if err != nil {
			return errMsg{err}
		}
		return eventsMsg{ch}
	}
}

// waitEvent blocks for the next event; it ends when the stream closes or the model quits.
func (m *Model) waitEvent() tea.Cmd {
	ch := m.events
	if ch == nil {
		return nil
	}
	return func() tea.Msg {
		select {
		case e, ok := <-ch:
			if !ok {
				return errMsg{fmt.Errorf("event stream closed")}
			}
			return eventMsg(e)
		case <-m.ctx.Done():
			return nil
		}
	}
}

// Update applies one message.
func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width, m.height = msg.Width, msg.Height
	case boardMsg:
		m.board = api.Board(msg)
		for _, s := range m.board.Slots {
			if s.Phase != api.PhaseStalled {
				continue
			}
			m.stalled[s.Ticket.ID] = true
		}
		m.clamp()
	case eventsMsg:
		m.events = msg.ch
		return m, m.waitEvent()
	case historyMsg:
		m.mergeHistory(msg.id, msg.evs)
	case eventMsg:
		return m, tea.Batch(m.applyEvent(api.Event(msg)), m.waitEvent())
	case errMsg:
		m.status = "error: " + msg.err.Error()
	case doneMsg:
		m.status = msg.note
		return m, m.loadBoard()
	case tea.KeyPressMsg:
		return m.key(msg)
	}
	return m, nil
}

// applyEvent records the event, handles stalled and merged locally, and reloads the board for the rest.
func (m *Model) applyEvent(e api.Event) tea.Cmd {
	if e.Ticket != "" && !hasEvent(m.timelines[e.Ticket], e) {
		m.timelines[e.Ticket] = trimTimeline(append(m.timelines[e.Ticket], e))
	}
	switch e.Kind {
	case "gate":
		m.gate = e
	case "needs-human":
		if r, ok := e.Data["reason"].(string); ok {
			m.reasons[e.Ticket] = r
		}
	case "stalled":
		m.stalled[e.Ticket] = true
		return nil
	case "merged":
		m.removeTicket(e.Ticket)
		return nil
	}
	if e.Ticket != "" {
		delete(m.stalled, e.Ticket)
	}
	return m.loadBoard()
}

func (m *Model) removeTicket(id api.TicketID) {
	b := &m.board
	b.MergeQueue = filter(b.MergeQueue, func(x api.TicketID) bool { return x != id })
	b.Ready = filter(b.Ready, func(x api.Ticket) bool { return x.ID != id })
	b.Slots = filter(b.Slots, func(x api.Slot) bool { return x.Ticket.ID != id })
	delete(m.stalled, id)
	m.clamp()
}

func filter[T any](in []T, keep func(T) bool) []T {
	out := make([]T, 0, len(in))
	for _, x := range in {
		if keep(x) {
			out = append(out, x)
		}
	}
	return out
}

// queueIDs lists the queue screen's rows: the merge queue, then ready tickets.
func (m *Model) queueIDs() []api.TicketID {
	ids := append([]api.TicketID(nil), m.board.MergeQueue...)
	for _, t := range m.board.Ready {
		ids = append(ids, t.ID)
	}
	return ids
}

func (m *Model) rows() int {
	if m.screen == screenQueue {
		return len(m.queueIDs())
	}
	return len(m.board.Slots)
}

func (m *Model) clamp() {
	if n := m.rows(); m.cursor >= n {
		m.cursor = max(n-1, 0)
	}
}

// selected is the ticket the keys act on.
func (m *Model) selected() (api.TicketID, bool) {
	switch m.screen {
	case screenTimeline:
		return m.tlID, m.tlID != ""
	case screenQueue:
		ids := m.queueIDs()
		if m.cursor < len(ids) {
			return ids[m.cursor], true
		}
	default:
		if m.cursor < len(m.board.Slots) {
			return m.board.Slots[m.cursor].Ticket.ID, true
		}
	}
	return "", false
}

func (m *Model) key(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch m.mode {
	case modeSteer:
		return m.keySteer(msg)
	case modeConfirmCancel:
		m.mode = modeNormal
		if msg.String() == "y" {
			return m, m.call("cancel", m.pending, func(id api.TicketID) error { return m.ctl.Cancel(m.ctx, id) })
		}
		m.status = "cancel aborted"
		return m, nil
	}
	m.status = ""
	switch msg.String() {
	case "q", "ctrl+c":
		m.cancel()
		return m, tea.Quit
	case "down", "j":
		if m.cursor+1 < m.rows() {
			m.cursor++
		}
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "tab":
		m.screen = (m.screen + 1) % screenTimeline
		m.cursor = 0
	case "enter":
		if m.screen != screenTimeline {
			if id, ok := m.selected(); ok {
				m.screen = screenTimeline
				return m, m.openTimeline(id)
			}
		}
	case "esc":
		if m.screen == screenTimeline {
			m.screen = screenBoard
			m.cursor = 0
		}
	case "s":
		if id, ok := m.selected(); ok {
			m.pending = id
			m.mode = modeSteer
			m.input.Reset()
			return m, m.input.Focus()
		}
	case "c":
		if id, ok := m.selected(); ok {
			m.pending = id
			m.mode = modeConfirmCancel
		}
	case "r":
		if id, ok := m.selected(); ok {
			return m, m.call("retry", id, func(id api.TicketID) error { return m.ctl.Retry(m.ctx, id) })
		}
	}
	return m, nil
}

func trimTimeline(tl []api.Event) []api.Event {
	if len(tl) > maxTimeline {
		return tl[len(tl)-maxTimeline:]
	}
	return tl
}

// hasEvent reports whether tl already holds an event equal to e. History and the live
// stream overlap when an event is emitted between subscribing and reading history.
func hasEvent(tl []api.Event, e api.Event) bool {
	for _, x := range tl {
		if x.Time.Equal(e.Time) && x.Kind == e.Kind && reflect.DeepEqual(x.Data, e.Data) {
			return true
		}
	}
	return false
}

// mergeHistory puts a ticket's past events before the live ones already held, without repeats.
func (m *Model) mergeHistory(id api.TicketID, past []api.Event) {
	merged := append([]api.Event(nil), past...)
	for _, e := range m.timelines[id] {
		if !hasEvent(merged, e) {
			merged = append(merged, e)
		}
	}
	m.timelines[id] = trimTimeline(merged)
}

// openTimeline shows a ticket's timeline and, when the Control keeps history, loads it once.
func (m *Model) openTimeline(id api.TicketID) tea.Cmd {
	m.tlID = id
	h, ok := m.ctl.(api.Historian)
	if !ok || m.loaded[id] {
		return nil
	}
	m.loaded[id] = true
	return func() tea.Msg {
		evs, err := h.History(m.ctx, id)
		if err != nil {
			return errMsg{err}
		}
		return historyMsg{id, evs}
	}
}

func (m *Model) keySteer(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "esc":
		m.mode = modeNormal
		m.input.Blur()
		return m, nil
	case "enter":
		text := strings.TrimSpace(m.input.Value())
		m.mode = modeNormal
		m.input.Blur()
		if text == "" {
			return m, nil
		}
		return m, m.call("steer", m.pending, func(id api.TicketID) error { return m.ctl.Steer(m.ctx, id, text) })
	}
	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

// call runs one Control action and reports its outcome.
func (m *Model) call(verb string, id api.TicketID, f func(api.TicketID) error) tea.Cmd {
	return func() tea.Msg {
		if err := f(id); err != nil {
			return errMsg{fmt.Errorf("%s %s: %w", verb, id, err)}
		}
		return doneMsg{note: verb + " " + string(id)}
	}
}

// View renders the current screen to exactly width x height cells.
func (m *Model) View() tea.View {
	w, h := m.width, m.height
	if w <= 0 || h <= 0 {
		w, h = defaultWidth, defaultHeight
	}
	body := m.body(w, h-4)
	lines := strings.Split(body, "\n")
	for len(lines) < h-4 {
		lines = append(lines, "")
	}
	lines = lines[:h-4]
	out := append([]string{m.header(w), ""}, lines...)
	out = append(out, m.footer(w)...)
	v := tea.NewView(strings.Join(out, "\n"))
	v.AltScreen = true
	return v
}

func (m *Model) header(w int) string {
	var parts []string
	for s := screenBoard; s <= m.screen || s < screenTimeline; s++ {
		if s == m.screen {
			parts = append(parts, styleSelected.Render("["+s.String()+"]"))
		} else {
			parts = append(parts, styleDim.Render(" "+s.String()+" "))
		}
	}
	return clip("factory  "+strings.Join(parts, " "), w)
}

func (m *Model) footer(w int) []string {
	line := fmt.Sprintf("fires left: %d", m.board.FiresLeft)
	switch m.mode {
	case modeSteer:
		return []string{clip(line, w), clip(m.input.View(), w)}
	case modeConfirmCancel:
		return []string{clip(line, w), clip(fmt.Sprintf("cancel #%s? y/n", m.pending), w)}
	}
	help := "j/k move  enter timeline  s steer  c cancel  r retry  tab screen  q quit"
	if m.status != "" {
		line += "  " + m.status
	}
	return []string{clip(line, w), clip(styleDim.Render(help), w)}
}

func (m *Model) body(w, h int) string {
	switch m.screen {
	case screenWaves:
		return m.wavesView(w)
	case screenQueue:
		return m.queueView(w, h)
	case screenTimeline:
		return m.timelineView(w, h)
	}
	return m.boardView(w, h)
}

const cardHeight = 4

func (m *Model) boardView(w, h int) string {
	slots := m.board.Slots
	if len(slots) == 0 {
		return styleDim.Render("no active slots")
	}
	per := max(h/cardHeight, 1)
	start := 0
	if m.cursor >= per {
		start = m.cursor - per + 1
	}
	end := min(start+per, len(slots))
	var cards []string
	for i := start; i < end; i++ {
		cards = append(cards, m.card(slots[i], i == m.cursor, w))
	}
	return strings.Join(cards, "\n")
}

func (m *Model) card(s api.Slot, sel bool, w int) string {
	flag := ""
	if m.stalled[s.Ticket.ID] || s.Phase == api.PhaseStalled {
		flag = "  " + styleStalled.Render("STALLED")
	}
	elapsed := "-"
	if s.Session != nil {
		elapsed = dur(m.now().Sub(s.Session.StartedAt))
	}
	push := "never"
	if !s.LastPush.IsZero() {
		push = dur(m.now().Sub(s.LastPush)) + " ago"
	}
	bar, _ := usageBar(s.Usage, s.Budget, 20)
	mark := "  "
	border := lipgloss.NormalBorder()
	style := lipgloss.NewStyle().Border(border).Width(w - 2)
	if sel {
		mark = "> "
		style = style.BorderForeground(lipgloss.Color("6"))
	}
	title := fmt.Sprintf("%s#%s %s", mark, s.Ticket.ID, s.Ticket.Title)
	l1 := fmt.Sprintf("%s  [%s]%s", title, s.Phase, flag)
	l2 := fmt.Sprintf("  elapsed %s   last push %s   usage %s", elapsed, push, bar)
	inner := w - 4
	return style.Render(clip(l1, inner) + "\n" + clip(l2, inner))
}

func (m *Model) queueView(w, h int) string {
	var sb strings.Builder
	row := 0
	line := func(id api.TicketID, label string) {
		mark := "  "
		if row == m.cursor {
			mark = "> "
		}
		if r := m.reasons[id]; r != "" {
			label = r
		}
		sb.WriteString(clip(fmt.Sprintf("%s#%s %s", mark, id, label), w) + "\n")
		row++
	}
	sb.WriteString(styleDim.Render("merge queue") + "\n")
	if len(m.board.MergeQueue) == 0 {
		sb.WriteString("  (empty)\n")
	}
	for _, id := range m.board.MergeQueue {
		line(id, "queued")
	}
	sb.WriteString(styleDim.Render("ready") + "\n")
	if len(m.board.Ready) == 0 {
		sb.WriteString("  (none)\n")
	}
	for _, t := range m.board.Ready {
		line(t.ID, fmt.Sprintf("P%d %s", t.Priority, t.Title))
	}
	sb.WriteString(m.gateView(w, h))
	return strings.TrimRight(sb.String(), "\n")
}

// gateView shows the newest gate event: how many runs, then the tail of its log when it carries one.
func (m *Model) gateView(w, h int) string {
	if m.gate.Kind == "" {
		return styleDim.Render("gate") + "\n  (no runs yet)\n"
	}
	out := styleDim.Render(fmt.Sprintf("gate  %s  runs=%v", m.gate.Time.Format("15:04:05"), m.gate.Data["runs"])) + "\n"
	log, _ := m.gate.Data["log"].(string)
	lines := strings.Split(strings.TrimRight(log, "\n"), "\n")
	if keep := max(h-12, 3); len(lines) > keep {
		lines = lines[len(lines)-keep:]
	}
	for _, l := range lines {
		if l != "" {
			out += clip("  "+l, w) + "\n"
		}
	}
	return out
}

// waves groups the board's tickets by dependency depth: wave 0 has no open blocker, wave n waits on wave n-1.
// A blocker that is not on the board is done. Tickets in a cycle share the last wave.
func waves(b api.Board) [][]api.TicketID {
	var ids []api.TicketID
	blockers := map[api.TicketID][]api.TicketID{}
	add := func(t api.Ticket) {
		ids = append(ids, t.ID)
		blockers[t.ID] = t.BlockedBy
	}
	for _, s := range b.Slots {
		add(s.Ticket)
	}
	for _, t := range b.Ready {
		add(t)
	}
	placed := map[api.TicketID]bool{}
	var out [][]api.TicketID
	for len(placed) < len(ids) {
		var wave []api.TicketID
		for _, id := range ids {
			if placed[id] {
				continue
			}
			open := false
			for _, d := range blockers[id] {
				if _, onBoard := blockers[d]; onBoard && !placed[d] {
					open = true
				}
			}
			if !open {
				wave = append(wave, id)
			}
		}
		if len(wave) == 0 { // cycle: everything left goes in one wave
			for _, id := range ids {
				if !placed[id] {
					wave = append(wave, id)
				}
			}
		}
		for _, id := range wave {
			placed[id] = true
		}
		out = append(out, wave)
	}
	return out
}

func (m *Model) wavesView(w int) string {
	ws := waves(m.board)
	if len(ws) == 0 {
		return styleDim.Render("no tickets")
	}
	title := map[api.TicketID]string{}
	phase := map[api.TicketID]api.Phase{}
	for _, s := range m.board.Slots {
		title[s.Ticket.ID], phase[s.Ticket.ID] = s.Ticket.Title, s.Phase
	}
	for _, t := range m.board.Ready {
		title[t.ID], phase[t.ID] = t.Title, api.PhaseReady
	}
	var out []string
	for i, wave := range ws {
		out = append(out, styleDim.Render(fmt.Sprintf("wave %d", i+1)))
		for _, id := range wave {
			out = append(out, clip(fmt.Sprintf("  #%s %s [%s]", id, title[id], phase[id]), w))
		}
	}
	return strings.Join(out, "\n")
}

func (m *Model) timelineView(w, h int) string {
	if m.tlID == "" {
		return styleDim.Render("no ticket selected")
	}
	evs := m.timelines[m.tlID]
	out := []string{fmt.Sprintf("timeline #%s", m.tlID)}
	if len(evs) == 0 {
		out = append(out, styleDim.Render("  no events yet"))
	}
	if keep := h - 1; len(evs) > keep && keep > 0 {
		evs = evs[len(evs)-keep:]
	}
	for _, e := range evs {
		out = append(out, clip(fmt.Sprintf("  %s  %-10s %s", e.Time.Format("15:04:05"), e.Kind, dataString(e.Data)), w))
	}
	return strings.Join(out, "\n")
}

func dataString(d map[string]any) string {
	keys := make([]string, 0, len(d))
	for k := range d {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%v", k, d[k]))
	}
	return strings.Join(parts, " ")
}

// usageBar draws used-over-budget as a bar of width cells and reports whether it is in the warning style.
// Only a percentage is shown, never raw token or cost figures.
func usageBar(u api.Usage, b api.Budget, width int) (string, bool) {
	var frac float64
	switch {
	case b.Tokens > 0:
		frac = float64(u.InputTokens+u.OutputTokens) / float64(b.Tokens)
	case b.USD > 0 && u.CostUSD > 0:
		frac = u.CostUSD / b.USD
	default:
		return styleDim.Render(strings.Repeat("-", width) + " no cap"), false
	}
	filled := min(int(frac*float64(width)+0.5), width)
	bar := strings.Repeat("█", filled) + strings.Repeat("░", width-filled)
	text := fmt.Sprintf("%s %d%%", bar, int(frac*100+0.5))
	if frac > warnAbove {
		return styleWarn.Render(text + " " + warnMarker), true
	}
	return text, false
}

// dur formats a duration as the two most useful units.
func dur(d time.Duration) string {
	if d < 0 {
		d = 0
	}
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
}

// clip cuts s to w display cells.
func clip(s string, w int) string {
	if lipgloss.Width(s) <= w {
		return s
	}
	return lipgloss.NewStyle().MaxWidth(w).Render(s)
}
