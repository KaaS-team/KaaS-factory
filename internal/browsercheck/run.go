package browsercheck

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"

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
	bctx, cancelCtx := chromedp.NewContext(ctx, chromedp.WithAllocatorOptions(append(chromedp.DefaultExecAllocatorOptions[:],
		chromedp.ExecPath(bin), chromedp.NoSandbox)...))
	defer cancelCtx()

	var mu sync.Mutex
	consoleErrs := 0
	if err := chromedp.Listen(bctx, func(ev any) {
		mu.Lock()
		defer mu.Unlock()
		switch e := ev.(type) {
		case *runtime.EventConsoleAPICalled:
			if e.Type == "error" {
				consoleErrs++
			}
		case *runtime.EventExceptionThrown:
			consoleErrs++
		}
	}); err != nil {
		return Result{Failed: 1, Message: "browser: " + err.Error()}
	}

	res := Result{}
	for i, s := range o.Steps {
		mu.Lock()
		errs := consoleErrs
		mu.Unlock()
		if err := runStep(bctx, s, o.OutDir, errs); err != nil {
			res.Failed = 1
			res.Message = fmt.Sprintf("browser: step %d %s: %v", i+1, s.Kind, err)
			return res
		}
		res.Passed++
	}
	return res
}

func runStep(ctx context.Context, s Step, outDir string, consoleErrs int) error {
	switch s.Kind {
	case "goto":
		return chromedp.Do(ctx, chromedp.Navigate(s.URL), chromedp.WaitReady("body"))
	case "click":
		return chromedp.Do(ctx, chromedp.Click(chromedp.CSS(s.Selector)))
	case "fill":
		return chromedp.Do(ctx, chromedp.SetValue(chromedp.CSS(s.Selector), s.Value))
	case "expect_text":
		body, err := chromedp.Run(ctx, chromedp.Text(chromedp.CSS("body")))
		if err != nil {
			return err
		}
		if !strings.Contains(body, s.Text) {
			return fmt.Errorf("text %q not found on page", s.Text)
		}
	case "expect_no_console_error":
		if consoleErrs > 0 {
			return fmt.Errorf("console error seen (%d)", consoleErrs)
		}
	case "screenshot":
		buf, err := chromedp.Run(ctx, chromedp.FullScreenshot(100))
		if err != nil {
			return err
		}
		return os.WriteFile(filepath.Join(outDir, s.Name+".png"), buf, 0o644)
	}
	return nil
}
