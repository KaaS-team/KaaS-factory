---
name: backlog-triage
on:
  cron:
    - schedule: "0 7 * * *"
      title: Daily backlog triage
      body: |
        Read the open issues with no type label. For each one, say its type, whether it is a
        duplicate, and what is missing to start it. If none are untyped, triage refuses with "backlog is clean".
stages:
  triage: {}
  done:
    uses: report
    needs: triage
---
A daily pass over the untyped backlog; it writes findings as comments and opens no PR.
