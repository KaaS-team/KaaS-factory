---
name: duplicate-clusters
on:
  cron:
    - schedule: "0 8 * * 5"
      title: Weekly duplicate issue clusters
      body: |
        Group the open issues that describe the same problem. For each group, name the issue to keep
        and the ones that repeat it. If no two open issues overlap, triage refuses with "no
        duplicates".
stages:
  triage: {}
  done:
    uses: report
    needs: triage
---
A weekly grouping of open issues that repeat each other; it writes the groups as comments and closes nothing.
