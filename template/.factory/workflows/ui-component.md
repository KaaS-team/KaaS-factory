---
name: ui-component
stages:
  triage: {}
  plan:
    needs: triage
    approval: on-risk:medium
  build:
    needs: plan
    gates: [lint, unit]
  verify:
    needs: build
  pr:
    needs: verify
---
Build or change one UI component. The plan names its states (empty, loading, error, full) and the
tests for each; a medium or high risk plan parks for a person, and the build is held to lint and unit.
