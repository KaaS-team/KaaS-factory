package github

import (
	"context"
	"errors"
	"fmt"
	"net/http"

	"github.com/KaaS-team/factory/internal/plancmd"
	gogithub "github.com/google/go-github/v79/github"
)

// Epic returns how `factory plan --epic n` reads epic issue n: its body. A missing issue is a
// "not found" error that names the epic.
func Epic(t *Tracker) plancmd.EpicFunc {
	return func(ctx context.Context, n int) (string, error) {
		if n <= 0 {
			return "", fmt.Errorf("github tracker: epic #%d is not an issue number", n)
		}
		is, _, err := t.client.Issues.Get(ctx, t.owner, t.repo, n)
		var ge *gogithub.ErrorResponse
		if errors.As(err, &ge) && ge.Response != nil && ge.Response.StatusCode == http.StatusNotFound {
			return "", fmt.Errorf("github tracker: epic #%d not found in %s/%s", n, t.owner, t.repo)
		}
		if err != nil {
			return "", fmt.Errorf("github tracker: read epic #%d: %w", n, err)
		}
		return is.GetBody(), nil
	}
}
