// Package remote is a sandbox backend that runs commands on a remote sandbox service over HTTP.
// It follows the shape E2B and microsandbox expose: create a box, run commands with streamed
// output, move files in and out, destroy the box. Base URL and token come from the environment.
package remote

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
)

// Environment variables that configure the client.
const (
	EnvURL   = "FACTORY_SANDBOX_URL"
	EnvToken = "FACTORY_SANDBOX_TOKEN"
)

// maxBody caps how much of an error body is read into a message.
const maxBody = 4 << 10

// CreateSpec describes the box to create.
type CreateSpec struct {
	Workdir  string   `json:"workdir,omitempty"`
	Env      []string `json:"env,omitempty"`
	AllowNet bool     `json:"allow_net"`
}

// Client talks to the remote sandbox API. Its methods match sandbox.Session.
type Client struct {
	base  string
	token string
	http  *http.Client
}

// New returns a client for base with a bearer token. A nil hc uses http.DefaultClient.
func New(base, token string, hc *http.Client) (*Client, error) {
	u, err := url.Parse(base)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("remote sandbox: bad base url %q", base)
	}
	if hc == nil {
		hc = http.DefaultClient
	}
	return &Client{base: strings.TrimRight(base, "/"), token: token, http: hc}, nil
}

// FromEnv builds a client from FACTORY_SANDBOX_URL and FACTORY_SANDBOX_TOKEN.
func FromEnv() (*Client, error) {
	base, token := os.Getenv(EnvURL), os.Getenv(EnvToken)
	if base == "" {
		return nil, errors.New("remote sandbox: " + EnvURL + " is not set")
	}
	if token == "" {
		return nil, errors.New("remote sandbox: " + EnvToken + " is not set")
	}
	return New(base, token, nil)
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, ctype string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	if ctype != "" {
		req.Header.Set("Content-Type", ctype)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("remote sandbox: %w", err)
	}
	if resp.StatusCode/100 != 2 {
		defer func() { _ = resp.Body.Close() }()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, maxBody))
		return nil, fmt.Errorf("remote sandbox: %s %s: %s: %s", method, path, resp.Status, strings.TrimSpace(string(b)))
	}
	return resp, nil
}

// Create makes a new box and returns its id.
func (c *Client) Create(ctx context.Context, spec CreateSpec) (string, error) {
	b, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	resp, err := c.do(ctx, http.MethodPost, "/sandboxes", bytes.NewReader(b), "application/json")
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	var out struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil || out.ID == "" {
		return "", errors.New("remote sandbox: create returned no id")
	}
	return out.ID, nil
}

// event is one line of the exec stream.
type event struct {
	Stream string `json:"stream"`
	Data   string `json:"data"`
	Exit   *int   `json:"exit"`
}

// ExitError is returned by Exec when the command ends with a non-zero status.
type ExitError struct{ Code int }

func (e *ExitError) Error() string {
	return fmt.Sprintf("remote sandbox: command exited with status %d", e.Code)
}

// Exec runs argv in the box. Output is copied to stdout and stderr as it arrives. A non-zero exit
// status comes back as *ExitError. A stream that ends without an exit line is an error.
func (c *Client) Exec(ctx context.Context, id string, argv []string, stdout, stderr io.Writer) error {
	b, err := json.Marshal(map[string]any{"argv": argv})
	if err != nil {
		return err
	}
	resp, err := c.do(ctx, http.MethodPost, "/sandboxes/"+url.PathEscape(id)+"/exec", bytes.NewReader(b), "application/json")
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64<<10), 4<<20)
	for sc.Scan() {
		line := bytes.TrimSpace(sc.Bytes())
		if len(line) == 0 {
			continue
		}
		var ev event
		if err := json.Unmarshal(line, &ev); err != nil {
			return fmt.Errorf("remote sandbox: bad exec event: %w", err)
		}
		switch {
		case ev.Exit != nil:
			if *ev.Exit != 0 {
				return &ExitError{Code: *ev.Exit}
			}
			return nil
		case ev.Stream == "stderr":
			_, _ = io.WriteString(stderr, ev.Data)
		default:
			_, _ = io.WriteString(stdout, ev.Data)
		}
	}
	if err := sc.Err(); err != nil {
		return fmt.Errorf("remote sandbox: exec stream: %w", err)
	}
	return errors.New("remote sandbox: exec stream ended without an exit status")
}

// CopyIn writes r to path inside the box.
func (c *Client) CopyIn(ctx context.Context, id, path string, r io.Reader) error {
	resp, err := c.do(ctx, http.MethodPut, "/sandboxes/"+url.PathEscape(id)+"/files?path="+url.QueryEscape(path), r, "application/octet-stream")
	if err != nil {
		return err
	}
	return resp.Body.Close()
}

// CopyOut streams the file at path inside the box to w.
func (c *Client) CopyOut(ctx context.Context, id, path string, w io.Writer) error {
	resp, err := c.do(ctx, http.MethodGet, "/sandboxes/"+url.PathEscape(id)+"/files?path="+url.QueryEscape(path), nil, "")
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if _, err := io.Copy(w, resp.Body); err != nil {
		return fmt.Errorf("remote sandbox: copy out: %w", err)
	}
	return nil
}

// Destroy removes the box. A box that is already gone is not an error.
func (c *Client) Destroy(ctx context.Context, id string) error {
	resp, err := c.do(ctx, http.MethodDelete, "/sandboxes/"+url.PathEscape(id), nil, "")
	if err != nil {
		if strings.Contains(err.Error(), "404") {
			return nil
		}
		return err
	}
	return resp.Body.Close()
}
