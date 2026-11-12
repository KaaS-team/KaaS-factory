// Ported from Aider-AI/aider@5dc9490 aider/repomap.py

package repomap

import (
	"context"
	"sort"
	"strings"
)

// EstimateTokens estimates the token count of s at four bytes per token.
func EstimateTokens(s string) int { return (len(s) + 3) / 4 }

// Build returns the symbol map for o, as large as fits o.Budget tokens. It searches for the number
// of ranked tags to show by binary search, as get_ranked_tags_map_uncached does, and stops early
// when the result is within 15 percent of the budget.
func Build(ctx context.Context, o Options) (string, error) {
	tags, err := Rank(ctx, o)
	if err != nil {
		return "", err
	}
	count := o.Tokens
	if count == nil {
		count = EstimateTokens
	}
	budget := o.Budget
	if budget <= 0 {
		return "", nil
	}
	lower, upper := 0, len(tags)
	middle := min(budget/25, len(tags))
	best, bestTokens := "", 0
	for lower <= upper {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		tree := render(tags[:middle])
		n := count(tree)
		pctErr := absf(float64(n-budget)) / float64(budget)
		const okErr = 0.15
		if (n <= budget && n > bestTokens) || pctErr < okErr {
			if n <= budget {
				best, bestTokens = tree, n
			}
			if pctErr < okErr && n <= budget {
				break
			}
		}
		if n < budget {
			lower = middle + 1
		} else {
			upper = middle - 1
		}
		middle = (lower + upper) / 2
	}
	return best, nil
}

func absf(f float64) float64 {
	if f < 0 {
		return -f
	}
	return f
}

// render lists the files of tags in first-seen order, each with its definition lines in source order.
func render(tags []Tag) string {
	var order []string
	byFile := map[string][]Tag{}
	for _, t := range tags {
		if _, ok := byFile[t.File]; !ok {
			order = append(order, t.File)
			byFile[t.File] = nil
		}
		if t.Name != "" {
			byFile[t.File] = append(byFile[t.File], t)
		}
	}
	var b strings.Builder
	for _, f := range order {
		b.WriteString(f + ":\n")
		ts := byFile[f]
		sort.SliceStable(ts, func(i, j int) bool { return ts[i].Line < ts[j].Line })
		last := -1
		for _, t := range ts {
			if t.Line == last {
				continue
			}
			last = t.Line
			b.WriteString("│" + strings.TrimRight(t.Text, " \t\r") + "\n")
		}
		b.WriteString("\n")
	}
	return b.String()
}
