---
name: ci-cost-review
on:
  cron:
    - schedule: "0 5 * * 1"
      title: Weekly CI cost and speed review
      body: |
        Read the last week of CI runs. Name the slowest jobs, the steps that repeat across jobs, and
        runs that a path filter or a cache would have skipped. Write each finding with the run it
        came from. If no job got slower or costlier than the week before, triage refuses with
        "ci is steady".
stages:
  triage: {}
  done:
    uses: report
    needs: triage
---
A weekly read of CI runs for slow and costly jobs; it writes findings as comments and opens no PR.
