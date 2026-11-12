// Package docgen renders the CLI and config reference documents from the code, deterministically.
package docgen

import (
	"fmt"
	"strings"

	"github.com/KaaS-team/factory/internal/config"
	"github.com/spf13/cobra"
	"github.com/spf13/pflag"
)

// CLI renders one markdown section per visible command under root, in command-name order, with use, short text and flags.
func CLI(root *cobra.Command) string {
	var b strings.Builder
	b.WriteString("# CLI reference\n\nGenerated from the command tree. Do not edit by hand.\n")
	walk(&b, root)
	return b.String()
}

func walk(b *strings.Builder, c *cobra.Command) {
	fmt.Fprintf(b, "\n## %s\n\n`%s`\n", c.CommandPath(), c.UseLine())
	if c.Short != "" {
		fmt.Fprintf(b, "\n%s\n", c.Short)
	}
	var rows []string
	add := func(f *pflag.Flag) {
		name := "--" + f.Name
		if f.Shorthand != "" {
			name = "-" + f.Shorthand + ", " + name
		}
		rows = append(rows, fmt.Sprintf("| `%s` | %s | `%s` | %s |", name, f.Value.Type(), f.DefValue, f.Usage))
	}
	c.NonInheritedFlags().VisitAll(add)
	if len(rows) > 0 {
		b.WriteString("\n| Flag | Type | Default | Description |\n|---|---|---|---|\n" + strings.Join(rows, "\n") + "\n")
	}
	for _, sub := range c.Commands() {
		if sub.Hidden || !sub.IsAvailableCommand() && sub.Name() != "help" {
			continue
		}
		if sub.Name() == "help" || sub.Name() == "completion" {
			continue
		}
		walk(b, sub)
	}
}

// Config renders every config key from internal/config with its type, default and org-layer rule.
func Config() string {
	var b strings.Builder
	b.WriteString("# Config reference\n\nGenerated from `internal/config`. Do not edit by hand.\n\n")
	b.WriteString("Layers, lowest to highest precedence: ")
	for i, l := range config.Layers() {
		if i > 0 {
			b.WriteString(", ")
		}
		b.WriteString(string(l))
	}
	b.WriteString(".\nEach key is a path in `.factory/factory.yaml`, the flag `--<key>`, and the variable `FACTORY_<KEY>` with dots as underscores.\n")
	b.WriteString("Keys under `models.` are open: any tier name takes a string.\n\n")
	b.WriteString("| Key | Type | Default | Layer rule |\n|---|---|---|---|\n")
	for _, k := range config.Describe() {
		fmt.Fprintf(&b, "| `%s` | %s | `%s` | %s |\n", k.Key, k.Type, k.Default, k.Rule)
	}
	return b.String()
}
