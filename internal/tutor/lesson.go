package tutor

import (
	"errors"
	"regexp"
	"strings"
)

var modelName = regexp.MustCompile(`(?i)claude|opus|sonnet|haiku|fable|gpt|gemini|llama|mistral`)

// Lesson is what a teacher reject teaches, filed by the retro stage.
type Lesson struct {
	Ticket   string
	Rule     string // opens with its place in brackets, such as [check]
	Evidence string
}

// Validate rejects a lesson that names a model; only tier names are allowed.
func (l Lesson) Validate() error {
	if modelName.MatchString(l.Rule + l.Evidence + l.Ticket) {
		return errors.New("tutor: lesson names a model, use tier names")
	}
	return nil
}

// Render returns the markdown block appended to .factory/memory/lessons.md.
func (l Lesson) Render() string {
	var b strings.Builder
	b.WriteString("- " + l.Rule + " (ticket " + l.Ticket + ")\n")
	b.WriteString("  Evidence: " + l.Evidence + "\n")
	return b.String()
}
