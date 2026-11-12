// Command price-refresh diffs the embedded price catalog against langfuse's price list at a pinned
// commit and prints a Markdown report of changed, missing and removed models. It exits 1 when
// anything differs, so a weekly CI job can open the report as an issue. Manual overrides win.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"

	"github.com/KaaS-team/factory/internal/meter/price"
)

var errDiffers = errors.New("catalog differs from upstream")

const upstreamURL = "https://raw.githubusercontent.com/langfuse/langfuse/%s/worker/src/constants/default-model-prices.json"

func main() {
	err := run(context.Background(), os.Args[1:], os.Stdout, fetch)
	if errors.Is(err, errDiffers) {
		os.Exit(1)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "price-refresh:", err)
		os.Exit(2)
	}
}

// fetch downloads the upstream price list at sha.
func fetch(ctx context.Context, sha string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, fmt.Sprintf(upstreamURL, sha), http.NoBody)
	if err != nil {
		return nil, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("upstream %s: %s", sha, resp.Status)
	}
	return io.ReadAll(resp.Body)
}

func run(ctx context.Context, args []string, out io.Writer, get func(context.Context, string) ([]byte, error)) error {
	fs := flag.NewFlagSet("price-refresh", flag.ContinueOnError)
	sha := fs.String("sha", "", "upstream commit to diff against (default: the embedded catalog's own commit)")
	file := fs.String("upstream", "", "read the upstream price list from this file instead of fetching it")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cat, err := price.Load()
	if err != nil {
		return err
	}
	if *sha == "" {
		*sha = cat.Source.SHA
	}
	var raw []byte
	if *file != "" {
		raw, err = os.ReadFile(*file)
	} else {
		raw, err = get(ctx, *sha)
	}
	if err != nil {
		return err
	}
	up, err := price.ParseUpstream(raw)
	if err != nil {
		return err
	}
	over, err := price.Overrides()
	if err != nil {
		return err
	}
	d := price.Diff(cat.Models(), up, over)
	if _, err := io.WriteString(out, d.Report(*sha)); err != nil {
		return err
	}
	if !d.Empty() {
		return errDiffers
	}
	return nil
}
