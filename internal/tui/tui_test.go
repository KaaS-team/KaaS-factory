package tui

import (
	"context"
	"flag"
	"os"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/KaaS-team/factory/internal/api"
)

var update = flag.Bool("update", false, "rewrite golden files")

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")

func strip(s string) string { return ansiRE.ReplaceAllString(s, "") }

// fakeControl records calls and serves a fixed board and a test-driven event channel.
type fakeControl struct {
	mu     sync.Mutex
	board  api.Board
	events chan api.Event
	calls  []string
}

func newFake(b api.Board) *fakeControl {
	return &fakeControl{board: b, events: make(chan api.Event, 8)}
}

func (f *fakeControl) rec(s string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, s)
	return nil
}

func (f *fakeControl) got() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.calls...)
}

func (f *fakeControl) Board(context.Context) (api.Board, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.board, nil
}
func (f *fakeControl) Dispatch(_ context.Context, id api.TicketID) error {
	return f.rec("dispatch " + string(id))
}
func (f *fakeControl) Steer(_ context.Context, id api.TicketID, m string) error {
	return f.rec("steer " + string(id) + ": " + m)
}
func (f *fakeControl) Cancel(_ context.Context, id api.TicketID) error {
	return f.rec("cancel " + string(id))
}
func (f *fakeControl) Retry(_ context.Context, id api.TicketID) error {
	return f.rec("retry " + string(id))
}
func (f *fakeControl) Events(context.Context) (<-chan api.Event, error) { return f.events, nil }

var t0 = time.Date(2026, 1, 2, 12, 0, 0, 0, time.UTC)

func fixedBoard() api.Board {
	slot := func(id, title string, ph api.Phase, startMin, pushMin int, used, cap int64) api.Slot {
		return api.Slot{
			Ticket:   api.Ticket{ID: api.TicketID(id), Title: title},
			Phase:    ph,
			Session:  &api.Session{Key: id + "-a1", StartedAt: t0.Add(-time.Duration(startMin) * time.Minute)},
			LastPush: t0.Add(-time.Duration(pushMin) * time.Minute),
			Usage:    api.Usage{InputTokens: used},
			Budget:   api.Budget{Tokens: cap},
		}
	}
	return api.Board{
		Slots: []api.Slot{
			slot("101", "Add the TUI board", api.PhaseRunning, 42, 3, 400, 1000),
			slot("102", "Port the merge queue", api.PhaseRunning, 90, 5, 900, 1000),
			slot("103", "Wire the dashboard", api.PhaseStalled, 130, 61, 100, 1000),
		},
		Ready:      []api.Ticket{{ID: "104", Title: "Docs sweep", Priority: 2}},
		MergeQueue: []api.TicketID{"99", "100"},
		FiresLeft:  7,
	}
}

func newModel(t *testing.T, b api.Board) (*Model, *fakeControl) {
	t.Helper()
	f := newFake(b)
	m := New(f).(*Model)
	m.now = func() time.Time { return t0 }
	var cmd tea.Cmd
	var mm tea.Model = m
	mm, cmd = mm.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = mm.(*Model)
	m = settle(t, m, cmd)
	// Init by hand: load the board and open the stream, but leave the blocking event wait to emit.
	nm, _ := m.Update(m.loadBoard()())
	nm, _ = nm.Update(m.subscribe()())
	return nm.(*Model), f
}

// emit sends one event through the fake stream and applies it, as the pending wait command would.
func emit(t *testing.T, m *Model, f *fakeControl, e api.Event) *Model {
	t.Helper()
	f.events <- e
	return settle(t, m, m.waitEvent())
}

// settle runs a command and feeds its message back, depth-first, skipping blocking event waits.
func settle(t *testing.T, m *Model, cmd tea.Cmd) *Model {
	t.Helper()
	if cmd == nil {
		return m
	}
	msg := runCmd(cmd)
	if msg == nil {
		return m
	}
	if b, ok := msg.(tea.BatchMsg); ok {
		for _, c := range b {
			m = settle(t, m, c)
		}
		return m
	}
	nm, next := m.Update(msg)
	return settle(t, nm.(*Model), next)
}

// runCmd runs cmd with a deadline so a command waiting on the event channel counts as pending.
func runCmd(cmd tea.Cmd) tea.Msg {
	ch := make(chan tea.Msg, 1)
	go func() { ch <- cmd() }()
	select {
	case m := <-ch:
		return m
	case <-time.After(50 * time.Millisecond):
		return nil
	}
}

func press(t *testing.T, m *Model, key string) (*Model, tea.Cmd) {
	t.Helper()
	nm, cmd := m.Update(keyMsg(key))
	return nm.(*Model), cmd
}

func keyMsg(k string) tea.KeyPressMsg {
	switch k {
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	}
	r := []rune(k)[0]
	return tea.KeyPressMsg{Code: r, Text: k}
}

func view(m *Model) string { return strip(m.View().Content) }

// Symphony §13.7 (status surface): the board renders every claimed slot with phase and stall state.
func TestGoldenBoard100x30(t *testing.T) {
	m, _ := newModel(t, fixedBoard())
	got := view(m)
	path := "testdata/board_100x30.golden"
	if *update {
		if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("view differs from golden\n--- got\n%s\n--- want\n%s", got, want)
	}
	lines := strings.Split(got, "\n")
	if len(lines) != 30 {
		t.Fatalf("want 30 lines, got %d", len(lines))
	}
	for i, l := range lines {
		if w := len([]rune(l)); w > 100 {
			t.Fatalf("line %d is %d wide", i, w)
		}
	}
}

func TestKeysCallControl(t *testing.T) {
	tests := []struct {
		name   string
		keys   []string
		calls  []string
		screen screen
	}{
		{"j moves down then retry", []string{"j", "r"}, []string{"retry 102"}, screenBoard},
		{"arrow down then up", []string{"down", "up", "r"}, []string{"retry 101"}, screenBoard},
		{"k at top stays", []string{"k", "r"}, []string{"retry 101"}, screenBoard},
		{"j at bottom stays", []string{"j", "j", "j", "j", "r"}, []string{"retry 103"}, screenBoard},
		{"enter opens timeline", []string{"enter"}, nil, screenTimeline},
		{"esc leaves timeline", []string{"enter", "esc"}, nil, screenBoard},
		{"tab to queue", []string{"tab"}, nil, screenQueue},
		{"tab twice to timeline", []string{"tab", "tab"}, nil, screenTimeline},
		{"tab thrice back to board", []string{"tab", "tab", "tab"}, nil, screenBoard},
		{"steer sends prompt", []string{"s", "h", "i", "enter"}, []string{"steer 101: hi"}, screenBoard},
		{"steer esc sends nothing", []string{"s", "h", "esc", "r"}, []string{"retry 101"}, screenBoard},
		{"cancel y confirms", []string{"c", "y"}, []string{"cancel 101"}, screenBoard},
		{"cancel n aborts", []string{"c", "n"}, nil, screenBoard},
		{"cancel needs confirm", []string{"c"}, nil, screenBoard},
		{"retry", []string{"r"}, []string{"retry 101"}, screenBoard},
		{"queue enter targets ready ticket", []string{"tab", "j", "j", "r"}, []string{"retry 104"}, screenQueue},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m, f := newModel(t, fixedBoard())
			for _, k := range tc.keys {
				var cmd tea.Cmd
				m, cmd = press(t, m, k)
				m = settle(t, m, cmd)
			}
			got := f.got()
			if strings.Join(got, "|") != strings.Join(tc.calls, "|") {
				t.Fatalf("calls = %v, want %v", got, tc.calls)
			}
			if m.screen != tc.screen {
				t.Fatalf("screen = %v, want %v", m.screen, tc.screen)
			}
		})
	}
}

func TestQuitKey(t *testing.T) {
	m, _ := newModel(t, fixedBoard())
	_, cmd := press(t, m, "q")
	if cmd == nil {
		t.Fatal("q returned no command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("q did not quit")
	}
}

func TestStalledEventMarksCard(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	if strings.Contains(view(m), "101") && cardLine(view(m), "101", "STALLED") {
		t.Fatal("101 stalled before the event")
	}
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "stalled", Ticket: "101"})
	if !cardLine(view(m), "101", "STALLED") {
		t.Fatalf("101 not marked stalled:\n%s", view(m))
	}
	if cardLine(view(m), "102", "STALLED") {
		t.Fatal("102 marked stalled")
	}
}

// cardLine reports whether the view has a line holding both ticket id and word.
func cardLine(v, id, word string) bool {
	for _, l := range strings.Split(v, "\n") {
		if strings.Contains(l, "#"+id) && strings.Contains(l, word) {
			return true
		}
	}
	return false
}

func TestMergedEventLeavesQueue(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	m, _ = press(t, m, "tab")
	if !strings.Contains(view(m), "#99") {
		t.Fatalf("99 missing from queue:\n%s", view(m))
	}
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "merged", Ticket: "99"})
	v := view(m)
	if strings.Contains(v, "#99") {
		t.Fatalf("99 still in queue:\n%s", v)
	}
	if !strings.Contains(v, "#100") {
		t.Fatalf("100 removed too:\n%s", v)
	}
}

func TestTimelineShowsTicketEvents(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "pushed", Ticket: "101", Data: map[string]any{"sha": "abc"}})
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "pushed", Ticket: "102"})
	m, _ = press(t, m, "enter")
	v := view(m)
	if !strings.Contains(v, "pushed") || !strings.Contains(v, "sha=abc") {
		t.Fatalf("timeline lacks 101 event:\n%s", v)
	}
	if strings.Count(v, "pushed") != 1 {
		t.Fatalf("timeline shows other ticket's events:\n%s", v)
	}
}

func TestUsageBarWarning(t *testing.T) {
	tests := []struct {
		name      string
		used, cap int64
		warn      bool
		wantPct   string
	}{
		{"half", 500, 1000, false, "50%"},
		{"exactly 80 is not warning", 800, 1000, false, "80%"},
		{"over 80 warns", 801, 1000, true, "80%"},
		{"90 warns", 900, 1000, true, "90%"},
		{"over budget clamps bar", 1500, 1000, true, "150%"},
		{"no cap", 500, 0, false, "no cap"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			raw, warn := usageBar(api.Usage{InputTokens: tc.used}, api.Budget{Tokens: tc.cap}, 10)
			if warn != tc.warn {
				t.Fatalf("warn = %v", warn)
			}
			plain := strip(raw)
			if !strings.Contains(plain, tc.wantPct) {
				t.Fatalf("bar %q lacks %q", plain, tc.wantPct)
			}
			if strings.Contains(plain, warnMarker) != tc.warn {
				t.Fatalf("marker presence wrong in %q", plain)
			}
			if tc.warn && raw == plain {
				t.Fatal("warning bar carries no style")
			}
		})
	}
}

func TestNoRawCountsInView(t *testing.T) {
	m, _ := newModel(t, fixedBoard())
	v := view(m)
	for _, bad := range []string{"900", "$"} {
		if strings.Contains(v, bad) {
			t.Fatalf("view leaks %q", bad)
		}
	}
}
