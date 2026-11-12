package safeout

import "strings"

var credentialSuffixes = []string{"_TOKEN", "_API_KEY", "_SECRET", "_PASSWORD"}

// AgentEnv returns environ without any tracker or other credential variable, so
// an agent session never holds a write credential. Only the apply stage has one.
func AgentEnv(environ []string) []string {
	var out []string
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		if isCredential(strings.ToUpper(name)) {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func isCredential(name string) bool {
	if name == "GH_TOKEN" || name == "GITHUB_TOKEN" {
		return true
	}
	for _, s := range credentialSuffixes {
		if strings.HasSuffix(name, s) {
			return true
		}
	}
	return false
}
