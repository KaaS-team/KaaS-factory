# OSS adoption

What the Go factory takes from each upstream, and how. SHAs are the heads checked on 2026-11-12;
a ticket that copies code pins its own SHA in the file header and in `THIRD_PARTY_NOTICES.md`
(`internal/provenance` fails the gate when they differ). Only MIT and Apache-2.0 code is copied or
pinned; AGPL, CC-BY-SA and unlicensed repos are ideas only.

| Upstream | Licence | Head | Mode | What we take |
|---|---|---|---|---|
| owainlewis/machinist | MIT | 4d7d776 | copy (Go) | runner process-group kill, usage parsing, githubauth, triggers, updater, merge-policy reasons |
| owainlewis/neo | MIT | f2bc8d1 | idea | TUI plan and worker panes |
| mitkox/esf | MIT | e5567fb | idea | per-run patch and evidence record |
| github/gh-aw | MIT | 1b7036a | idea | markdown workflows with YAML frontmatter; safe outputs |
| makifbaysal/tasktrooper | Apache-2.0 | 96d8af7 | idea | agent CLI adapters as data |
| Agent-Field/SWE-AF | Apache-2.0 | 2587bc2 | idea | adaptive ticket DAG, replan on failure |
| runkora/kora | Apache-2.0 | f43dc3d | idea (ee/) | policy check before action, per-agent identity |
| the-open-engine/zeroshot | MIT | 191cf27 | idea | workflow graph; verify in a fresh session |
| the-open-engine/opcore | Apache-2.0 | ddcff26 | pack (check) | per-edit guardrail check |
| obra/superpowers | MIT | 22f0b46 | pack (skill) | systematic-debugging, verification-before-completion |
| mattpocock/skills | MIT | 5863806 | pack (skill) | domain-modeling, grilling, codebase-design |
| addyosmani/agent-skills | MIT | 301b02b | pack (skill) | code-review-and-quality |
| rudderlabs/devbox | MIT | 60cd61c | idea | Linear/Jira intake, PR-comment fix loop |
| open-inspect/background-agents | MIT | 8e994a2 | idea | Slack/webhook entry, PR attribution |
| os-factory/har | Apache-2.0 | 34c2a60 | idea | MCP tool shape |
| OpenAI Symphony spec | spec | `playbooks/research/symphony-spec.md` | contract | reconcile states, tick order, backoff, token accounting, conformance list |
