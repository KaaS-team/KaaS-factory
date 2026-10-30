# Competitive landscape and what we take

Research date: 30 Oct 2026. Four Opus read-only passes over five groups of public repos. We read the code, we ran none of it. Each claim below is from the repo named; the full per-source reports hold the file paths. Licences matter: we port MIT and Apache 2.0 code with the notice kept, and never copy from a source-available `ee/` folder.

## One-paragraph verdict

Nobody else combines a team model with policy ceilings, a tracker-driven autonomous runner, a consultancy audit engine and 95% automation sold as outcomes. SuperPlane is the one direct competitor and it is a heavy Go platform. The rest are single-developer workflow kits (AI Blueprint, Buildline) or chat-bot templates (CopilotKit). We win by staying lean and configurable, and by taking the small, proven safety and measurement ideas they each got right.

## Per source

| Source | What it is | Licence | Threat | What we take |
|---|---|---|---|---|
| SuperPlane (8.4k stars) | Go + React platform, "factory for one-shot engineering", v1.0.0 on 27 Oct 2026 | Apache 2.0 outside `ee/` | Direct competitor | Lifecycle table, append-only events with one `transition()` writer, scored checks, MCP tool descriptions, typed artifacts, two token scopes, metrics route |
| AI Blueprint (491 stars) | One developer, one repo, chat-driven workflow kit | MIT | Low; a `blueprint` npm name clash | Findings ledger format, audit coverage block, routing evals, proportionality findings |
| Buildline (12 stars) | Markdown playbooks and guard scripts copied into a repo | MIT | None | Finding-checker agent, commit-bound approvals, REVIEW.md seed |
| CopilotKit OpenTag, OpenBot, OpenDuet, OpenMuse | MIT templates that need CopilotKit's hosted Intelligence service | MIT (AG-UI MIT) | None | Digest-bound approvals, tool annotations, run-trigger on audit rows, typed handoff caps |

## Where we are already ahead

Teams and policy ceilings; tracker-driven autonomy by risk; holdout tests and base-versus-head acceptance; protected paths at write time; cost and merge-rate metrics; cloud runtimes; the consultancy engine (repo, process and PR lenses, 30/60/90 windows); signed receipts.

## What we do not copy

SuperPlane's canvas editor, Go + gRPC + RabbitMQ + Postgres stack, 51 integrations, Casbin RBAC and token resale. CopilotKit's hosted-service dependency, telemetry on by default, per-bot containers and vendoring-as-forking. Buildline's dashboard and folder-per-feature state. AG-UI as our internal model (our CloudEvents log stays the source of truth; AG-UI at most a read-only projection, only when a client asks).

## A real gap in our own code

`workflow.ts` auto-approves after a timeout with no record that no human decided (CopilotKit finding, to verify in code). It becomes a P0 ticket.

## How it adds value to the product

1. **Trust.** Approvals bound to a digest and a commit sha, finding-checker, timed approvals recorded as such. These are what a security-minded buyer asks first.
2. **Speed and cost.** The finding-checker cuts false rejects, one of our top reject causes. Reviewing only the diff since the last review cuts revise cost.
3. **One truth.** An append-only event log with one writer feeds the board, metrics, MCP and audit export without drift.
4. **Selling.** Scored checks, `metrics.get` and a public read-only board produce the evidence for fixed-fee offers: cost per merged change, merge rate, judge veto rate.
5. **Consultancy.** A findings format with stable IDs and statuses is the key the re-audit delta is computed on; coverage blocks stop a partial audit being called full.

## Offerings to modules (proposal for the owner to confirm)

Offerings are in `kaaslabs/kaas.team/src/content/offers.ts`. This map is a proposal, not shipped.

| Offering | Delivered by | Owner decision (the 5%) |
|---|---|---|
| 2-week Diagnostic Sprint | auditor repo, process and PR lenses, one report | which lenses and tools to run, sign-off |
| 12-week Factory Transformation | `factory onboard`, team files in the client's factory-config, 30/60/90 backlog filed to their tracker | roster, workflow, risk ceilings |
| Continuous Care | factory in shadow mode then autonomy levels, monthly re-audit | when to raise autonomy |
| Claude Code rollout, training, Buildcamp | playbooks repo training paths mapped to lwp courses | curriculum choice |
| KaaS Spec, Context, Review, Guard, Pulse | blueprint (spec, context), factory judge and gates (review, guard), metrics and board (pulse) | which modules a client switches on |

## Tickets and order

Priority follows the plan waves. P0 is wave 2 (from 1 Nov), P1 wave 3, P2 wave 4 or later. Every ticket starts as an intake issue labelled `needs-plan`; Opus expands it to the planned format before its wave starts. Source ticket numbers are in each issue body.

New private repos: `factory-config` (dogfood org and team files) and `playbooks` (tool catalogue, 2-week audit and 30/60/90 playbooks, rubric). No other new repo is needed.
