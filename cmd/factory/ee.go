//go:build ee

// SPDX-License-Identifier: LicenseRef-KaaS-EE

package main

import (
	"fmt"
	"net/http"
	"os"

	"github.com/spf13/cobra"

	"github.com/KaaS-team/factory/ee/policy"
	"github.com/KaaS-team/factory/ee/scim"
	"github.com/KaaS-team/factory/internal/api"
	"github.com/KaaS-team/factory/internal/config"
)

// eeBuild reports whether the enterprise commands are compiled in.
const eeBuild = true

// addEE mounts the enterprise commands and, when FACTORY_POLICY names a rules file, puts the policy
// check in front of dispatch and retry. With the variable unset the check is off.
func addEE(root *cobra.Command) {
	root.AddCommand(policyCmd(), scimCmd())
	next := newControl
	newControl = func(cfg config.Config) (api.Control, error) {
		c, err := next(cfg)
		path := os.Getenv("FACTORY_POLICY")
		if err != nil || path == "" {
			return c, err
		}
		e, err := loadPolicy(path)
		if err != nil {
			return nil, err
		}
		role := os.Getenv("FACTORY_ROLE")
		return policy.Guard(c, e, policy.Actor{ID: actorID(), Role: role}, os.Stderr), nil
	}
}

func actorID() string {
	if id := os.Getenv("FACTORY_ACTOR"); id != "" {
		return id
	}
	return "cli"
}

func loadPolicy(path string) (*policy.Engine, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("policy: %w", err)
	}
	return policy.Parse(data)
}

func policyCmd() *cobra.Command {
	var rules, role, repo string
	var usd float64
	cmd := &cobra.Command{
		Use:   "policy <action>",
		Short: "Check an action against a policy rules file (enterprise)",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			e, err := loadPolicy(rules)
			if err != nil {
				return err
			}
			d := e.Check(cmd.Context(), policy.Actor{ID: actorID(), Role: role}, policy.Action(args[0]), policy.Resource{Repo: repo, USD: usd})
			verdict := "deny"
			if d.Allow {
				verdict = "allow"
			}
			_, _ = fmt.Fprintf(cmd.OutOrStdout(), "%s %s: %s\n", verdict, d.RuleID, d.Reason)
			if !d.Allow {
				return fmt.Errorf("policy denied %s", args[0])
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&rules, "rules", "", "path to the YAML rules file")
	cmd.Flags().StringVar(&role, "role", "", "actor role")
	cmd.Flags().StringVar(&repo, "repo", "", "repository the action touches")
	cmd.Flags().Float64Var(&usd, "usd", 0, "spend the action would add")
	_ = cmd.MarkFlagRequired("rules")
	return cmd
}

func scimCmd() *cobra.Command {
	var addr string
	cmd := &cobra.Command{
		Use:   "scim",
		Short: "Serve SCIM 2.0 Users and Groups for an identity provider (enterprise)",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, _ []string) error {
			token := os.Getenv("FACTORY_SCIM_TOKEN")
			if token == "" {
				return fmt.Errorf("scim: set FACTORY_SCIM_TOKEN to the bearer token the identity provider sends")
			}
			srv := &http.Server{Addr: addr, Handler: scim.NewHandler(scim.NewMemoryStore(), token)}
			go func() { <-cmd.Context().Done(); _ = srv.Close() }()
			if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
				return err
			}
			return nil
		},
	}
	cmd.Flags().StringVar(&addr, "addr", "127.0.0.1:8089", "listen address")
	return cmd
}
