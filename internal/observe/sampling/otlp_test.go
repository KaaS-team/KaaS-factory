package sampling

import (
	"testing"

	"github.com/KaaS-team/factory/internal/api"
)

func TestUsageFromAttrs(t *testing.T) {
	for _, c := range []struct {
		name  string
		attrs map[string]any
		want  api.Usage
		ok    bool
	}{
		{"none", map[string]any{"other": 1}, api.Usage{}, false},
		{"current keys", map[string]any{
			"gen_ai.usage.input_tokens": int64(10), "gen_ai.usage.output_tokens": 4.0,
			"gen_ai.usage.cache_read.input_tokens": "3", "gen_ai.usage.cache_creation.input_tokens": 2,
		}, api.Usage{InputTokens: 10, OutputTokens: 4, CacheReadTokens: 3, CacheWriteTokens: 2}, true},
		{"legacy keys", map[string]any{"gen_ai.usage.prompt_tokens": 7, "gen_ai.usage.completion_tokens": 1},
			api.Usage{InputTokens: 7, OutputTokens: 1}, true},
		{"current wins over legacy", map[string]any{"gen_ai.usage.input_tokens": 5, "gen_ai.usage.prompt_tokens": 9},
			api.Usage{InputTokens: 5}, true},
		{"bad value ignored", map[string]any{"gen_ai.usage.input_tokens": "x", "gen_ai.usage.output_tokens": -3},
			api.Usage{}, false},
	} {
		got, ok := UsageFromAttrs(c.attrs)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: got %+v %v, want %+v %v", c.name, got, ok, c.want, c.ok)
		}
	}
}
