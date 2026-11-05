---
name: weekly-report
on:
  cron:
    - schedule: "0 9 * * 1"
      title: Weekly spend and outcome report
      body: |
        Report the last seven days: runs started, shipped, parked and failed, and the spend per
        workflow from the run log. If no run finished in that time, triage refuses with "no runs
        this week".
stages:
  triage: {}
  done:
    uses: report
    needs: triage
---
A weekly report of runs by outcome and spend per workflow; it writes the report as a comment and opens no PR.
