package tui

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/api/porttest"
)

var update = flag.Bool("update", false, "rewrite golden files")

var ansiRE = regexp.MustCompile("\x1b\\[[0-9;?]*[ -/]*[@-~]")

func strip(s string) string { return ansiRE.ReplaceAllString(s, "") }

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

func newModel(t *testing.T, b api.Board) (*Model, *porttest.Control) {
	t.Helper()
	f := porttest.NewControl(b)
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
func emit(t *testing.T, m *Model, f *porttest.Control, e api.Event) *Model {
	t.Helper()
	f.Push(e)
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
		{"tab to waves", []string{"tab"}, nil, screenWaves},
		{"tab twice to queue", []string{"tab", "tab"}, nil, screenQueue},
		{"tab thrice back to board", []string{"tab", "tab", "tab"}, nil, screenBoard},
		{"steer sends prompt", []string{"s", "h", "i", "enter"}, []string{"steer 101: hi"}, screenBoard},
		{"steer esc sends nothing", []string{"s", "h", "esc", "r"}, []string{"retry 101"}, screenBoard},
		{"cancel y confirms", []string{"c", "y"}, []string{"cancel 101"}, screenBoard},
		{"cancel n aborts", []string{"c", "n"}, nil, screenBoard},
		{"cancel needs confirm", []string{"c"}, nil, screenBoard},
		{"retry", []string{"r"}, []string{"retry 101"}, screenBoard},
		{"queue enter targets ready ticket", []string{"tab", "tab", "j", "j", "r"}, []string{"retry 104"}, screenQueue},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			m, f := newModel(t, fixedBoard())
			for _, k := range tc.keys {
				var cmd tea.Cmd
				m, cmd = press(t, m, k)
				m = settle(t, m, cmd)
			}
			got := f.Calls()
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

// Ticket history: the timeline loads past events first, then follows live ones once each.
func TestTimelineLoadsHistoryThenFollowsLiveOnce(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	past := api.Event{V: 1, Time: t0.Add(-time.Minute), Kind: "dispatched", Ticket: "101", Data: map[string]any{"attempt": 1}}
	f.Seed("101", past, api.Event{V: 1, Time: t0.Add(-30 * time.Second), Kind: "pushed", Ticket: "101", Data: map[string]any{"branch": "b1"}})
	m, cmd := press(t, m, "enter")
	m = settle(t, m, cmd)
	v := view(m)
	for _, want := range []string{"dispatched", "attempt=1", "branch=b1"} {
		if !strings.Contains(v, want) {
			t.Fatalf("timeline lacks %q:\n%s", want, v)
		}
	}
	if strings.Index(v, "dispatched") > strings.Index(v, "pushed") {
		t.Fatalf("history out of order:\n%s", v)
	}
	live := api.Event{V: 1, Time: t0, Kind: "stalled", Ticket: "101", Data: map[string]any{"message": "nudge"}}
	// Apply events directly: emit's pending wait command may swallow a second pushed event.
	nm, _ := m.Update(eventMsg(live))
	nm, _ = nm.Update(eventMsg(past)) // already in history: the snapshot raced the stream
	m = nm.(*Model)
	v = view(m)
	if n := strings.Count(v, "stalled"); n != 1 {
		t.Fatalf("live event shown %d times:\n%s", n, v)
	}
	if n := strings.Count(v, "dispatched"); n != 1 {
		t.Fatalf("history event duplicated by the stream:\n%s", v)
	}
	if got := f.HistoryCalls(); len(got) != 1 || got[0] != "101" {
		t.Fatalf("History calls = %v", got)
	}
}

func TestTimelineHistoryKeepsLiveEventsSeenBeforeItLoaded(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "stalled", Ticket: "101"})
	f.Seed("101", api.Event{V: 1, Time: t0.Add(-time.Minute), Kind: "dispatched", Ticket: "101"})
	m, cmd := press(t, m, "enter")
	m = settle(t, m, cmd)
	v := view(m)
	if !strings.Contains(v, "dispatched") || strings.Count(v, "stalled") != 1 {
		t.Fatalf("history and live not merged:\n%s", v)
	}
	if strings.Index(v, "dispatched") > strings.Index(v, "stalled") {
		t.Fatalf("history not before live:\n%s", v)
	}
}

func TestTimelineWithoutHistorianStillWorks(t *testing.T) {
	f := porttest.NewControl(fixedBoard())
	m := New(f.ControlOnly()).(*Model)
	m.now = func() time.Time { return t0 }
	nm, _ := m.Update(boardMsg(fixedBoard()))
	m, cmd := press(t, nm.(*Model), "enter")
	if cmd != nil {
		t.Fatalf("a Control without Historian queued a command")
	}
	if !strings.Contains(view(m), "no events yet") {
		t.Fatalf("timeline:\n%s", view(m))
	}
}

func wavesBoard() api.Board {
	b := fixedBoard()
	b.Slots[0].Ticket.BlockedBy = nil
	b.Slots[1].Ticket.BlockedBy = []api.TicketID{"101"}
	b.Slots[2].Ticket.BlockedBy = []api.TicketID{"101", "102"}
	b.Ready[0].BlockedBy = []api.TicketID{"103", "999"} // 999 is done, not on the board
	return b
}

func TestWaves(t *testing.T) {
	tests := []struct {
		name string
		b    api.Board
		want [][]api.TicketID
	}{
		{"empty", api.Board{}, nil},
		{"no deps is one wave", fixedBoard(), [][]api.TicketID{{"101", "102", "103", "104"}}},
		{"chain and fan in", wavesBoard(), [][]api.TicketID{{"101"}, {"102"}, {"103"}, {"104"}}},
		{"cycle lands in a last wave", api.Board{Ready: []api.Ticket{
			{ID: "1", BlockedBy: []api.TicketID{"2"}}, {ID: "2", BlockedBy: []api.TicketID{"1"}}}},
			[][]api.TicketID{{"1", "2"}}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := waves(tc.b)
			if fmt.Sprint(got) != fmt.Sprint(tc.want) {
				t.Fatalf("waves = %v, want %v", got, tc.want)
			}
		})
	}
}

func goldenCheck(t *testing.T, path, got string) {
	t.Helper()
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
		t.Fatalf("view differs from golden %s\n--- got\n%s\n--- want\n%s", path, got, want)
	}
}

// Symphony §8.2 (dispatch eligibility): a ticket waits for every blocker, so the DAG reads as waves.
func TestGoldenWaves100x30(t *testing.T) {
	m, _ := newModel(t, wavesBoard())
	m, _ = press(t, m, "tab")
	if m.screen != screenWaves {
		t.Fatalf("tab did not open waves, screen = %v", m.screen)
	}
	goldenCheck(t, "testdata/waves_100x30.golden", view(m))
}

// Symphony §13.7: the queue screen shows the merge queue and the gate's last output.
func TestGoldenQueue100x30(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "gate", Data: map[string]any{"runs": 2, "log": "ok  pkg/a\nFAIL pkg/b\n--- FAIL: TestB"}})
	m, _ = press(t, m, "tab")
	m, _ = press(t, m, "tab")
	if m.screen != screenQueue {
		t.Fatalf("screen = %v", m.screen)
	}
	goldenCheck(t, "testdata/queue_100x30.golden", view(m))
}

// The board and queue are driven by a stream: a gate event shows without a reload of the queue screen.
func TestQueueShowsEjectionReason(t *testing.T) {
	m, f := newModel(t, fixedBoard())
	m = emit(t, m, f, api.Event{V: 1, Time: t0, Kind: "needs-human", Ticket: "100", Data: map[string]any{"reason": "gate failed"}})
	m, _ = press(t, m, "tab")
	m, _ = press(t, m, "tab")
	if !cardLine(view(m), "100", "gate failed") {
		t.Fatalf("queue lacks reason:\n%s", view(m))
	}
}

// Only internal/api may be an internal dependency of the TUI.
func TestImportsOnlyAPI(t *testing.T) {
	out, err := exec.Command("go", "list", "-deps", "-f", "{{if not .Standard}}{{.ImportPath}}{{end}}", ".").Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, p := range strings.Fields(string(out)) {
		if strings.HasPrefix(p, "github.com/KaaS-team/factory/internal/") &&
			p != "github.com/KaaS-team/factory/internal/tui" &&
			p != "github.com/KaaS-team/factory/internal/api" {
			t.Errorf("internal/tui depends on %s", p)
		}
	}
}
