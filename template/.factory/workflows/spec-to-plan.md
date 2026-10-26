---
name: spec-to-plan
stages:
  triage: {}
  plan:
    needs: triage
  done:
    uses: report
    needs: plan
---
Turn the spec in this issue into a plan: acceptance criteria, non-goals, files to touch and tests to
write first. The plan comment is the output; no code is written and the issue closes.
