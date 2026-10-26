---
paths:
  - "**/api/**"
  - "**/routes/**"
  - "**/route.ts"
  - "**/server/**"
  - "**/workers/**"
  - "**/webhooks/**"
---

# API and service rules

From the house engineering standard; the repo's `AGENTS.md` wins where it says so.

| Area | Rule |
|---|---|
| Auth | Default-deny; public routes come from an allow-list, proven by a test that walks every route |
| Cross-tenant | Return 404, never 403 (403 leaks that the row exists) |
| Errors | One envelope: `code`, `message`, `requestId` |
| Idempotency | Webhook and retry paths take an idempotency key; queue handlers are idempotent |
| Timeouts | Every outbound call has one |
| Retries | Bounded, jittered, with a poison path |
| Rate limits | Redis-backed, never in memory |
| Per-process state | No in-memory caches or `setInterval` schedulers without a leader lock |
| Contracts | Client and server share request/response types from one package |
| Versioning | Additive; a breaking change gets a new path |
| Config | Validated at boot; anything that would no-op when unset refuses to start |
