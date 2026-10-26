---
name: ci-cd-authoring
stages:
  triage: {}
  plan:
    needs: triage
    approval: always
  build:
    needs: plan
    gates: [lint]
  verify:
    needs: build
  pr:
    needs: verify
---
Write or change a CI or deploy pipeline. Every plan parks for a person, since a pipeline holds the
keys to production; the build is held to the lint gate.
