package browsercheck

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chromedp/cdproto/runtime"
	"github.com/chromedp/chromedp"
)

// chromeNames are the binaries LookChrome tries, in order.
var chromeNames = []string{"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"}

// LookChrome returns the first Chrome binary found through look, or an error when there is none.
func LookChrome(look func(string) (string, error)) (string, error) {
	for _, n := range chromeNames {
		if p, err := look(n); err == nil && p != "" {
			return p, nil
		}
	}
	return "", errors.New("browser: chrome not found")
}

// Options configures Run.
type Options struct {
	Steps  []Step
	OutDir string                       // screenshots are written here
	Look   func(string) (string, error) // finds a binary on PATH; os.LookPath when nil
	// Profile is a Chrome user-data-dir whose Local State and Default profile are copied, without
	// caches, into a temp dir for the run. Empty runs with a fresh profile.
	Profile  string
	Secrets  Secrets // values type_secret may type; they never appear in the result
	TempRoot string  // where the run's temp dir goes; os.TempDir() when empty
}

// Result is the outcome of one run.
type Result struct {
	Passed  int
	Failed  int
	Message string // empty when every step passed, else why the first failing step failed
}

// Line returns the FACTORY_GATES line for the result.
func (r Result) Line() string {
	if r.Failed > 0 {
		return fmt.Sprintf("FACTORY_GATES: status=RED passed=%d failed=%d skipped=0 failed_gates=browser", r.Passed, r.Failed)
	}
	return fmt.Sprintf("FACTORY_GATES: status=GREEN passed=%d failed=0 skipped=0 failed_gates=-", r.Passed)
}

// Run executes the steps in headless Chrome and stops at the first failing step.
// It fails, never passes, when Chrome is missing.
func Run(ctx context.Context, o Options) Result {
	root := o.TempRoot
	if root == "" {
		root = os.TempDir()
	}
	SweepStale(root, time.Now())
	look := o.Look
	if look == nil {
		look = func(n string) (string, error) { return exec.LookPath(n) }
	}
	bin, err := LookChrome(look)
	if err != nil {
		return Result{Failed: 1, Message: err.Error()}
	}
	if err := os.MkdirAll(o.OutDir, 0o755); err != nil {
		return Result{Failed: 1, Message: "browser: " + err.Error()}
	}
	dir, release, err := workDir(root)
	if err != nil {
		return Result{Failed: 1, Message: "browser: " + err.Error()}
	}
	defer release()
	if o.Profile != "" {
		if err := CopyProfile(o.Profile, "Default", dir); err != nil {
			return Result{Failed: 1, Message: "browser: profile: " + err.Error()}
		}
	}
	bctx, cancelCtx := chromedp.NewContext(ctx, chromedp.WithAllocatorOptions(append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(bin), chromedp.NoSandbox, chromedp.UserDataDir(dir))...))
	defer cancelCtx()

	console, err := watchConsole(bctx)
	if err != nil {
		return Result{Failed: 1, Message: "browser: " + err.Error()}
	}
	env, err := newPageEnv(bctx)
	if err != nil {
		return Result{Failed: 1, Message: "browser: " + err.Error()}
	}
	return runStepList(bctx, env, o, console)
}

// consoleCount counts console errors and uncaught exceptions seen on the page.
type consoleCount struct {
	mu sync.Mutex
	n  int
}

func (c *consoleCount) add() {
	c.mu.Lock()
	c.n++
	c.mu.Unlock()
}

func (c *consoleCount) get() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.n
}

// watchConsole starts counting console errors on the browser context.
func watchConsole(bctx context.Context) (*consoleCount, error) {
	c := &consoleCount{}
	err := chromedp.Listen(bctx, func(ev any) {
		switch e := ev.(type) {
		case *runtime.EventConsoleAPICalled:
			if e.Type == "error" {
				c.add()
			}
		case *runtime.EventExceptionThrown:
			c.add()
		}
	})
	return c, err
}

// runStepList runs each step in order and stops at the first failure.
func runStepList(bctx context.Context, env *pageEnv, o Options, console *consoleCount) Result {
	res := Result{}
	for i, s := range o.Steps {
		if err := runStep(bctx, env, s, o, console.get()); err != nil {
			res.Failed = 1
			res.Message = o.Secrets.Redact(fmt.Sprintf("browser: step %d %s: %v", i+1, s.Kind, err))
			return res
		}
		res.Passed++
	}
	return res
}

// settleAll is what every action waits for before the next step runs.
var settleAll = Conditions{Ready: true, Quiet: true, Network: true}

const (
	actionCap   = time.Second
	quietWindow = 80 * time.Millisecond
)

// runStep runs one step. Actions settle the page afterwards; checks do not.
func runStep(ctx context.Context, env *pageEnv, s Step, o Options, consoleErrs int) error {
	began := env.now()
	var err error
	switch s.Kind {
	case "goto":
		err = chromedp.Do(ctx, chromedp.Navigate(s.URL))
	case "click":
		err = chromedp.Do(ctx, chromedp.Click(chromedp.CSS(s.Selector)))
	case "fill":
		err = chromedp.Do(ctx, chromedp.SetValue(chromedp.CSS(s.Selector), s.Value))
	case "type_secret":
		err = typeSecret(ctx, s, o.Secrets)
	case "expect_text":
		return expectText(ctx, s.Text)
	case "expect_no_console_error":
		if consoleErrs > 0 {
			return fmt.Errorf("console error seen (%d)", consoleErrs)
		}
		return nil
	case "screenshot":
		return screenshot(ctx, filepath.Join(o.OutDir, s.Name+".png"))
	default:
		return nil
	}
	if err != nil {
		return err
	}
	Settle(env, settleAll, actionCap, quietWindow, began)
	return nil
}

func typeSecret(ctx context.Context, s Step, secrets Secrets) error {
	host, err := pageHost(ctx)
	if err != nil {
		return err
	}
	v, err := secrets.Lookup(s.Name, host)
	if err != nil {
		return err
	}
	return chromedp.Do(ctx, chromedp.Clear(chromedp.CSS(s.Selector)), chromedp.SendKeys(chromedp.CSS(s.Selector), v))
}

func expectText(ctx context.Context, want string) error {
	body, err := chromedp.Run(ctx, chromedp.Text(chromedp.CSS("body")))
	if err != nil {
		return err
	}
	if !strings.Contains(body, want) {
		return fmt.Errorf("text %q not found on page", want)
	}
	return nil
}

func screenshot(ctx context.Context, path string) error {
	buf, err := chromedp.Run(ctx, chromedp.FullScreenshot(100))
	if err != nil {
		return err
	}
	return os.WriteFile(path, buf, 0o644)
}

// pageHost returns the host of the page the run is on, empty when it cannot be read.
func pageHost(ctx context.Context) (string, error) {
	loc, err := chromedp.Run(ctx, chromedp.Location())
	if err != nil {
		return "", err
	}
	u, err := url.Parse(loc)
	if err != nil {
		return "", nil
	}
	return u.Hostname(), nil
}
