package budget

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sync"
	"time"
)

var (
	errEOF      = io.EOF
	bytesReader = func(b []byte) io.Reader { return bytes.NewReader(b) }
)

// ErrOverBudget is returned by Allow when a scope has spent its limit.
var ErrOverBudget = errors.New("over budget")

// Guard answers Allow from live budgets and ledger rows.
type Guard struct {
	Budgets func() ([]Budget, error)
	Rows    func() ([]Row, error)
	Now     func() time.Time
}

var (
	mu      sync.RWMutex
	current *Guard
)

// Configure sets the guard that Allow uses. Dispatch calls it once at start up.
func Configure(g *Guard) {
	mu.Lock()
	defer mu.Unlock()
	current = g
}

// Allow returns nil when scope may start more work, and an error wrapping ErrOverBudget when its
// budget is spent. A scope with no budget, or no configured guard, is allowed. Dispatch calls it
// before it starts a session.
func Allow(scope string) error {
	mu.RLock()
	g := current
	mu.RUnlock()
	if g == nil {
		return nil
	}

	bs, err := g.Budgets()
	if err != nil {
		return err
	}
	rows, err := g.Rows()
	if err != nil {
		return err
	}
	now := time.Now
	if g.Now != nil {
		now = g.Now
	}
	for _, s := range Check(rows, bs, now()) {
		if s.Scope == scope && s.State == Over {
			return fmt.Errorf("%s: %w: spent $%.2f of $%.2f this %s", scope, ErrOverBudget, s.Spent, s.Limit, s.Period)
		}
	}
	return nil
}
