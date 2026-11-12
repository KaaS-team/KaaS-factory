package sampling

import (
	"strconv"

	"github.com/KaaS-team/factory/internal/api"
)

// usageKeys lists the OTel GenAI usage attributes, current name first, per
// meter usage field. The names are the OpenTelemetry GenAI conventions.
var usageKeys = []struct {
	keys []string
	set  func(*api.Usage, int64)
}{
	{[]string{"gen_ai.usage.input_tokens", "gen_ai.usage.prompt_tokens"}, func(u *api.Usage, n int64) { u.InputTokens = n }},
	{[]string{"gen_ai.usage.output_tokens", "gen_ai.usage.completion_tokens"}, func(u *api.Usage, n int64) { u.OutputTokens = n }},
	{[]string{"gen_ai.usage.cache_read.input_tokens"}, func(u *api.Usage, n int64) { u.CacheReadTokens = n }},
	{[]string{"gen_ai.usage.cache_creation.input_tokens"}, func(u *api.Usage, n int64) { u.CacheWriteTokens = n }},
}

// UsageFromAttrs maps gen_ai.usage.* span attributes to the meter's usage
// fields. It reports false when no attribute held a usable token count.
func UsageFromAttrs(attrs map[string]any) (api.Usage, bool) {
	var u api.Usage
	found := false
	for _, f := range usageKeys {
		for _, k := range f.keys {
			if n, ok := count(attrs[k]); ok {
				f.set(&u, n)
				found = true
				break
			}
		}
	}
	return u, found
}

func count(v any) (int64, bool) {
	var n int64
	switch x := v.(type) {
	case int:
		n = int64(x)
	case int64:
		n = x
	case float64:
		n = int64(x)
	case string:
		p, err := strconv.ParseInt(x, 10, 64)
		if err != nil {
			return 0, false
		}
		n = p
	default:
		return 0, false
	}
	return n, n >= 0
}
