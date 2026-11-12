package vendorkit

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"time"

	"github.com/KaaS-team/factory/pkg/retry"
)

// StatusError is a non-2xx answer. Its message names the path, never the query.
type StatusError struct {
	Method, Path string
	Status       int
	Body         string
}

func (e *StatusError) Error() string {
	return fmt.Sprintf("%s %s answered %d: %s", e.Method, e.Path, e.Status, e.Body)
}

// Client sends requests with a per-attempt timeout and bounded, jittered retries.
// Zero fields take defaults; Sleep exists so tests need no clock.
type Client struct {
	HTTP       *http.Client
	Timeout    time.Duration // per attempt, default 30s
	MaxRetries int           // retries after the first attempt, default 3
	Base       time.Duration // first backoff, default 500ms
	Sleep      func(ctx context.Context, d time.Duration) error
}

const maxWait = 30 * time.Second

func (c *Client) defaults() (h *http.Client, timeout time.Duration, retries int, base time.Duration) {
	h, timeout, retries, base = c.HTTP, c.Timeout, c.MaxRetries, c.Base
	if h == nil {
		h = http.DefaultClient
	}
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	if retries <= 0 {
		retries = 3
	}
	if base <= 0 {
		base = 500 * time.Millisecond
	}
	return
}

// Do sends one request and returns the body of a 2xx answer. A 429, a 5xx or a transport error is
// retried up to MaxRetries times; any other status is returned at once as a *StatusError.
func (c *Client) Do(ctx context.Context, method, rawURL string, header http.Header, body []byte) ([]byte, error) {
	h, timeout, retries, base := c.defaults()
	path := rawURL
	if u, err := url.Parse(rawURL); err == nil {
		path = u.Path
	}
	var retryAfter time.Duration
	loop := retry.Loop{
		Policy: retry.NewExponentialRetryPolicy(base).WithMaximumInterval(maxWait).
			WithExpirationInterval(retry.NoInterval).WithMaximumAttempts(retries + 1),
		IsRetryable: func(err error) bool {
			var se *StatusError
			return !errors.As(err, &se) || se.Status == http.StatusTooManyRequests || se.Status >= 500
		},
		MinDelay: func(error) time.Duration { return min(retryAfter, maxWait) },
		Sleep:    c.Sleep,
	}
	var out []byte
	err := loop.Do(ctx, func(ctx context.Context) error {
		var err error
		out, retryAfter, err = c.once(ctx, h, timeout, method, rawURL, path, header, body)
		if err != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) once(ctx context.Context, h *http.Client, timeout time.Duration, method, rawURL, path string, header http.Header, body []byte) ([]byte, time.Duration, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, rawURL, bytes.NewReader(body))
	if err != nil {
		return nil, 0, fmt.Errorf("%s %s: %w", method, path, err)
	}
	for k, v := range header {
		req.Header[k] = v
	}
	res, err := h.Do(req)
	if err != nil {
		return nil, 0, fmt.Errorf("%s %s: %w", method, path, stripURL(err))
	}
	defer func() { _ = res.Body.Close() }()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, 0, fmt.Errorf("%s %s: %w", method, path, err)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		cut := string(text)
		if len(cut) > 200 {
			cut = cut[:200]
		}
		secs, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return nil, time.Duration(secs) * time.Second, &StatusError{method, path, res.StatusCode, cut}
	}
	return text, 0, nil
}

// stripURL drops the URL (and so any query) that net/http puts in its errors.
func stripURL(err error) error {
	var ue *url.Error
	if errors.As(err, &ue) {
		return ue.Err
	}
	return err
}
