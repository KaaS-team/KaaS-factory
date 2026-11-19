package config

import (
	"slices"
	"strings"
	"testing"
)

func TestRuntimeEnvVarsAreNotConfigKeys(t *testing.T) {
	for _, name := range runtimeEnv {
		t.Run(name, func(t *testing.T) {
			if _, err := Load(Sources{Env: []string{name + "=x"}}); err != nil {
				t.Fatalf("Load with %s set: %v", name, err)
			}
		})
	}
	for _, name := range []string{"FACTORY_MCP_TOKEN", "FACTORY_A2A_TOKEN", "FACTORY_ALLOWED_HOSTS", "FACTORY_ALLOWED_ORIGINS"} {
		if !slices.Contains(runtimeEnv, name) {
			t.Errorf("%s missing from runtimeEnv", name)
		}
	}
}

func TestRuntimeEnvDoesNotHideMisspelledKey(t *testing.T) {
	l, err := Load(Sources{Env: []string{"FACTORY_MCP_TOKEN=x", "FACTORY_SLOTZ=3", "FACTORY_SLOTS=2"}})
	if err == nil || !strings.Contains(err.Error(), `unknown key "slotz"`) {
		t.Fatalf("want unknown key slotz, got %v (%v)", err, l)
	}
	if strings.Contains(err.Error(), "mcp_token") {
		t.Fatalf("runtime variable reported as unknown: %v", err)
	}
}
