package mergeq

import (
	"context"
	"fmt"
	"strings"
)

// Applier says where a head's change no longer applies onto a base.
type Applier interface {
	// Stale returns the paths whose change in head conflicts with base; empty means head applies.
	Stale(ctx context.Context, base, head string) ([]string, error)
}

// Syntax checks changed files of a head. It is optional: a build without parser grammars leaves it nil
// and the syntax step is skipped.
type Syntax interface {
	// Invalid returns the first path in paths that does not parse at head, and why; empty path means all parse.
	Invalid(ctx context.Context, head string, paths []string) (path, reason string, err error)
}

// Failure is a PR that failed the precheck, with the path that failed and why.
type Failure struct {
	ID     string
	Path   string
	Reason string
}

// Precheck runs before a batch is planned. A PR that fails goes back to its agent through Return, not on in the queue.
type Precheck struct {
	Applier Applier
	Syntax  Syntax // nil skips the syntax step
	// Paths lists the files head changes, for the syntax step; unused when Syntax is nil.
	Paths func(ctx context.Context, id, head string) ([]string, error)
	// Return hands a failed PR back to its agent.
	Return func(ctx context.Context, f Failure) error
}

// Filter returns the entries that pass against base, in order, and the failures. It does not call Return.
func (p *Precheck) Filter(ctx context.Context, base string, es []Entry) ([]Entry, []Failure, error) {
	var ok []Entry
	var bad []Failure
	for _, e := range es {
		f, err := p.check(ctx, base, e)
		if err != nil {
			return nil, nil, fmt.Errorf("precheck %s: %w", e.ID, err)
		}
		if f != nil {
			bad = append(bad, *f)
			continue
		}
		ok = append(ok, e)
	}
	return ok, bad, nil
}

func (p *Precheck) check(ctx context.Context, base string, e Entry) (*Failure, error) {
	stale, err := p.Applier.Stale(ctx, base, e.Head)
	if err != nil {
		return nil, err
	}
	if len(stale) > 0 {
		return &Failure{ID: e.ID, Path: stale[0], Reason: "does not apply onto the current base; conflicts in " + strings.Join(stale, ", ")}, nil
	}
	if p.Syntax == nil || p.Paths == nil {
		return nil, nil
	}
	paths, err := p.Paths(ctx, e.ID, e.Head)
	if err != nil {
		return nil, err
	}
	path, reason, err := p.Syntax.Invalid(ctx, e.Head, paths)
	if err != nil {
		return nil, err
	}
	if path != "" {
		return &Failure{ID: e.ID, Path: path, Reason: "syntax error: " + reason}, nil
	}
	return nil, nil
}
