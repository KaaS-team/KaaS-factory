// Ported from openrewrite/rewrite@90219c5 rewrite-core/src/main/java/org/openrewrite/ScanningRecipe.java
// Licensed under the Apache License, Version 2.0; the per-file deadline follows scheduling/SourceFileDeadline.java
// and the run CSV columns follow table/RecipeRunStats.java, all at the same commit.

// Package scanedit is a two-node workflow: Scan reads every file and writes an accumulator to disk,
// Edit reads that accumulator and rewrites files. Each file call has a deadline; a file that exceeds
// it is abandoned, reported and the run continues. Rows go to a CSV that folds into a scorecard row.
package scanedit

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/KaaS-team/factory/internal/eval"
)

// Step names and results written to the run CSV.
const (
	StepScan      = "scan"
	StepEdit      = "edit"
	ResultOK      = "ok"
	ResultTimeout = "timeout"
	ResultError   = "error" // a row's Result is "error: <reason>"
)

// Acc is the accumulator: facts the scan pass found, keyed by name (for example old symbol to new symbol).
type Acc map[string]string

// ScanFunc reads one file and returns the facts it holds. It cannot write the file.
type ScanFunc func(ctx context.Context, file string, src []byte) (Acc, error)

// EditFunc returns the new content of one file given the accumulator, and the tokens it spent.
type EditFunc func(ctx context.Context, file string, src []byte, acc Acc) ([]byte, int64, error)

// Config names the files of a run. Files are relative to Root.
type Config struct {
	Root     string
	Files    []string
	AccPath  string        // where the scan node writes the accumulator and the edit node reads it
	Deadline time.Duration // per file and per pass step; zero means none
}

// Row is one line of the run CSV.
type Row struct {
	File   string
	Step   string
	Result string
	Tokens int64
}

// within runs fn under the deadline. A function that ignores ctx is abandoned: its goroutine ends
// when fn returns, and its result is dropped.
func within[T any](ctx context.Context, d time.Duration, fn func(context.Context) (T, error)) (T, error) {
	if d > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, d)
		defer cancel()
	}
	type res struct {
		v   T
		err error
	}
	ch := make(chan res, 1)
	go func() { v, err := fn(ctx); ch <- res{v, err} }()
	select {
	case r := <-ch:
		return r.v, r.err
	case <-ctx.Done():
		var zero T
		return zero, ctx.Err()
	}
}

func result(err error) string {
	switch {
	case err == nil:
		return ResultOK
	case errors.Is(err, context.DeadlineExceeded):
		return ResultTimeout
	default:
		return ResultError + ": " + err.Error()
	}
}

// Scan runs fn over every file, merges the facts and writes them to cfg.AccPath. A file that errors,
// times out or contradicts an earlier fact gets a non-ok row; the other files still count.
func Scan(ctx context.Context, cfg Config, fn ScanFunc) ([]Row, error) {
	acc, rows := Acc{}, make([]Row, 0, len(cfg.Files))
	for _, f := range cfg.Files {
		if err := ctx.Err(); err != nil {
			return rows, err
		}
		src, err := os.ReadFile(filepath.Join(cfg.Root, f))
		var got Acc
		if err == nil {
			got, err = within(ctx, cfg.Deadline, func(c context.Context) (Acc, error) { return fn(c, f, src) })
		}
		if err == nil {
			err = merge(acc, got)
		}
		rows = append(rows, Row{File: f, Step: StepScan, Result: result(err)})
	}
	b, err := json.Marshal(acc)
	if err != nil {
		return rows, err
	}
	return rows, os.WriteFile(cfg.AccPath, b, 0o600)
}

// merge adds got to acc unless a key already holds a different value; then it changes nothing.
func merge(acc, got Acc) error {
	for k, v := range got {
		if old, ok := acc[k]; ok && old != v {
			return fmt.Errorf("conflicting facts for %q: %q and %q", k, old, v)
		}
	}
	for k, v := range got {
		acc[k] = v
	}
	return nil
}

// Edit reads the accumulator from cfg.AccPath and runs fn over every file, writing the result back
// only when fn finishes inside the deadline. A hung or failed file is left as it was.
func Edit(ctx context.Context, cfg Config, fn EditFunc) ([]Row, error) {
	b, err := os.ReadFile(cfg.AccPath)
	if err != nil {
		return nil, fmt.Errorf("edit needs the scan accumulator: %w", err)
	}
	var acc Acc
	if err := json.Unmarshal(b, &acc); err != nil {
		return nil, fmt.Errorf("read accumulator: %w", err)
	}
	type out struct {
		src    []byte
		tokens int64
	}
	rows := make([]Row, 0, len(cfg.Files))
	for _, f := range cfg.Files {
		if err := ctx.Err(); err != nil {
			return rows, err
		}
		p := filepath.Join(cfg.Root, f)
		src, err := os.ReadFile(p)
		var o out
		if err == nil {
			o, err = within(ctx, cfg.Deadline, func(c context.Context) (out, error) {
				s, n, e := fn(c, f, src, acc)
				return out{s, n}, e
			})
		}
		if err == nil {
			err = os.WriteFile(p, o.src, 0o600)
		}
		rows = append(rows, Row{File: f, Step: StepEdit, Result: result(err), Tokens: o.tokens})
	}
	return rows, nil
}

var csvHeader = []string{"file", "step", "result", "tokens"}

// WriteCSV writes the run table with a header line.
func WriteCSV(w io.Writer, rows []Row) error {
	cw := csv.NewWriter(w)
	_ = cw.Write(csvHeader)
	for _, r := range rows {
		_ = cw.Write([]string{r.File, r.Step, r.Result, strconv.FormatInt(r.Tokens, 10)})
	}
	cw.Flush()
	return cw.Error()
}

// ReadCSV reads a table WriteCSV wrote and rejects any other header.
func ReadCSV(r io.Reader) ([]Row, error) {
	recs, err := csv.NewReader(r).ReadAll()
	if err != nil {
		return nil, err
	}
	if len(recs) == 0 || len(recs[0]) != len(csvHeader) {
		return nil, errors.New("run csv: bad header")
	}
	for i, h := range csvHeader {
		if recs[0][i] != h {
			return nil, errors.New("run csv: bad header")
		}
	}
	rows := make([]Row, 0, len(recs)-1)
	for _, rec := range recs[1:] {
		n, err := strconv.ParseInt(rec[3], 10, 64)
		if err != nil {
			return nil, fmt.Errorf("run csv: tokens %q: %w", rec[3], err)
		}
		rows = append(rows, Row{File: rec[0], Step: rec[1], Result: rec[2], Tokens: n})
	}
	return rows, nil
}

// Scorecard folds a run's rows into one scorecard row: it passes only when every row is ok, and
// tokens are summed into InputTokens (the CSV does not split input from output).
func Scorecard(fixture string, rows []Row) eval.TicketResult {
	tr := eval.TicketResult{Fixture: fixture, HiddenPass: true, Attempts: 1}
	for _, r := range rows {
		tr.InputTokens += r.Tokens
		if r.Result != ResultOK {
			tr.HiddenPass = false
		}
	}
	return tr
}
