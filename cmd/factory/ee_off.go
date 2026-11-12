//go:build !ee

package main

import "github.com/spf13/cobra"

// eeBuild reports whether the enterprise commands are compiled in.
const eeBuild = false

// addEE mounts nothing: the default build carries no enterprise code.
func addEE(*cobra.Command) {}
