package github

import (
	"strings"
	"time"

	"github.com/KaaS-team/factory/internal/marker"
)

// Comment is one issue comment as the codec and trust rules see it.
type Comment struct {
	ID        int64
	Author    string
	Body      string
	CreatedAt time.Time
}

// FindStatus returns the latest comment that carries the status marker.
func FindStatus(comments []Comment) (Comment, bool) {
	for i := len(comments) - 1; i >= 0; i-- {
		if strings.Contains(comments[i].Body, marker.Status) {
			return comments[i], true
		}
	}
	return Comment{}, false
}
