---
name: ci-fix
stages:
  triage: {}
  build:
    needs: triage
    gates: [lint, unit]
  verify:
    needs: build
  pr:
    needs: verify
---
Fix the failing CI run this issue links. Triage names the failing job and its first error; the build
fixes the cause, never a skip or a retry, and is held to the lint and unit gates before verify.
