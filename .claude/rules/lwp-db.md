---
paths:
  - "**/db/**"
  - "**/drizzle/**"
  - "**/migrations/**"
  - "**/schema*.ts"
  - "**/*.sql"
  - "**/models/**"
---

# Database rules

From the house engineering standard; the repo's `AGENTS.md` wins where it says so.

| Area | Rule |
|---|---|
| Tenancy | Every domain table has a tenant FK, every read filters on it, and a test asserts both |
| Pagination | Keyset, never offset, on anything that grows |
| Reads | Every query has a `LIMIT` or a bounded key; index every FK you filter on |
| Migrations | Forward-only, idempotent, safe to run on boot from N replicas |

Fixtures must exceed one page to test paging.
