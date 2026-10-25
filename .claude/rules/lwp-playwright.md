---
paths:
  - "**/e2e/**"
  - "**/*.spec.ts"
  - "**/playwright.config.*"
---

# End-to-end tests

- Never run an e2e suite while another session's dev server holds its port; the lwp-eng `guard-e2e-port` hook refuses it.
- "Flaky" is not a diagnosis: reproduce, capture the log, name the cause.
- A paging test needs a fixture larger than one page.
