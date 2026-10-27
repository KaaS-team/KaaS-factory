---
name: pr-review
on:
  event: factory.pr.opened
stages:
  triage: {}
  review:
    uses: plan
    needs: triage
  done:
    uses: report
    needs: review
---
Review the pull request this issue names. Triage reads its diff and the issue it closes; the review
stage writes findings as the plan comment: each one with the file, the line, why it matters and a
fix. It opens no PR of its own and closes the issue when the review is posted.
