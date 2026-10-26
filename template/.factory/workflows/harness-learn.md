---
name: harness-learn
on:
  cron:
    - schedule: "0 5 * * 1"
      title: Weekly harness review
      body: |
        Read last week's parked and failed runs (`factory harness eval`) and their comments. Propose
        one change to .factory/workflows, .claude/skills or .factory/memory that would have stopped
        the most common failure. If every run shipped, triage refuses with "nothing to learn".
stages:
  triage: {}
  plan:
    needs: triage
    approval: always
  build:
    needs: plan
  pr:
    needs: build
---
The factory proposes a change to its own harness from what failed; a person approves every plan.
