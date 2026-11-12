package logs

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
)

// Local tails a local session's output file. Each complete line is one event:
// a stream-json line becomes its type and text, any other line becomes kind
// "output". Cursors are byte offsets.
type Local struct {
	// Path is the output file. It may not exist yet.
	Path string
	// Ended reports whether the session's process has exited. It is checked
	// before each read, so the poll that sees true also holds the last lines.
	Ended func(ctx context.Context) (bool, error)
	// Now stamps lines that carry no time of their own.
	Now func() time.Time
}

// Poll reads the complete lines after the cursor offset.
func (l *Local) Poll(ctx context.Context, cursor string) (Page, error) {
	var off int64
	if cursor != "" {
		n, err := strconv.ParseInt(cursor, 10, 64)
		if err != nil || n < 0 {
			return Page{}, errors.New("logs: bad local cursor")
		}
		off = n
	}
	ended := false
	if l.Ended != nil {
		var err error
		if ended, err = l.Ended(ctx); err != nil {
			return Page{}, err
		}
	}
	now := l.Now
	if now == nil {
		now = time.Now
	}
	f, err := os.Open(l.Path)
	if errors.Is(err, os.ErrNotExist) {
		return Page{Next: cursor, Done: ended}, nil
	}
	if err != nil {
		return Page{}, err
	}
	defer func() { _ = f.Close() }()
	if _, err := f.Seek(off, io.SeekStart); err != nil {
		return Page{}, err
	}
	data, err := io.ReadAll(f)
	if err != nil {
		return Page{}, err
	}
	if !ended { // a half-written last line waits for its newline
		if i := bytes.LastIndexByte(data, '\n'); i >= 0 {
			data = data[:i+1]
		} else {
			data = nil
		}
	}
	var evs []Event
	for _, line := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		evs = append(evs, localEvent(line, now()))
	}
	return Page{Events: evs, Next: strconv.FormatInt(off+int64(len(data)), 10), Done: ended}, nil
}

func localEvent(line string, now time.Time) Event {
	var j struct {
		Type    string `json:"type"`
		Subtype string `json:"subtype"`
		Result  string `json:"result"`
		Message struct {
			Content []struct {
				Type string `json:"type"`
				Text string `json:"text"`
				Name string `json:"name"`
			} `json:"content"`
		} `json:"message"`
	}
	if json.Unmarshal([]byte(line), &j) != nil || j.Type == "" {
		return Event{Time: now, Kind: "output", Text: line}
	}
	text := j.Result
	for _, c := range j.Message.Content {
		switch {
		case c.Text != "":
			text += c.Text
		case c.Name != "":
			text += c.Type + " " + c.Name
		}
	}
	if text == "" {
		text = j.Subtype
	}
	return Event{Time: now, Kind: j.Type, Text: text}
}
