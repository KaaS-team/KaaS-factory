package main

import (
	"strings"
	"testing"

	"github.com/KaaS-team/factory/internal/config"
)

// sandbox_runtime: remote picks the remote sandbox. The local dispatcher refuses to start without the
// service URL, takes it when set, and rejects a runtime it does not know.
func TestSandboxRuntimeRemoteIsSelectedFromConfig(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("FACTORY_SANDBOX_URL", "")
	t.Setenv("FACTORY_SANDBOX_TOKEN", "")
	build := dispatchers["local"]
	cfg := config.Config{SandboxRuntime: "remote", Slots: 1}
	if _, err := build(t.Context(), cfg); err == nil || !strings.Contains(err.Error(), "FACTORY_SANDBOX_URL") {
		t.Fatalf("no service set: %v", err)
	}
	t.Setenv("FACTORY_SANDBOX_URL", "http://127.0.0.1:1")
	t.Setenv("FACTORY_SANDBOX_TOKEN", "tok")
	if _, err := build(t.Context(), cfg); err != nil {
		t.Fatalf("service set: %v", err)
	}
	cfg.SandboxRuntime = "vm"
	if _, err := build(t.Context(), cfg); err == nil || !strings.Contains(err.Error(), "sandbox_runtime") {
		t.Fatalf("unknown runtime: %v", err)
	}
}
