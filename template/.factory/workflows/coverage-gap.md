---
name: coverage-gap
on:
  cron:
    - schedule: "0 4 * * 2"
      title: Weekly coverage gap
      body: |
        Find the least covered module that changed in the last month and add tests for its riskiest
        branch. If coverage did not drop anywhere, triage refuses with "no coverage gap".
stages:
  triage: {}
  build:
    needs: triage
    gates: [unit]
  verify:
    needs: build
  pr:
    needs: verify
---
A weekly hunt for untested code that changed: tests only, held to the unit gate.
