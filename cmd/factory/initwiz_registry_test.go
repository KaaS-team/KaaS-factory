package main

import (
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/KaaS-team/factory/internal/initwiz"
)

// Every config `factory init` writes must name a tracker and dispatcher this binary can build,
// or `factory run` and `factory mcp` refuse the file init just wrote.
func TestInitWritesOnlyRegisteredAdapters(t *testing.T) {
	for _, name := range initwiz.Dispatchers() {
		if _, ok := dispatchers[name]; !ok {
			t.Errorf("init offers dispatcher %q, which no adapter is registered for", name)
		}
	}
	for _, name := range initwiz.Trackers() {
		if _, ok := trackers[name]; !ok {
			t.Errorf("init offers tracker %q, which no adapter is registered for", name)
		}
	}
	for _, tier := range initwiz.Tiers() {
		data, err := initwiz.Render(initwiz.Answers{Tier: tier, Tracker: "github"})
		if err != nil {
			t.Fatalf("render %s: %v", tier, err)
		}
		var got struct{ Dispatcher string }
		if err := yaml.Unmarshal(data, &got); err != nil {
			t.Fatalf("parse %s: %v", tier, err)
		}
		if _, ok := dispatchers[got.Dispatcher]; !ok {
			t.Errorf("tier %s writes dispatcher %q, which no adapter is registered for", tier, got.Dispatcher)
		}
	}
}
