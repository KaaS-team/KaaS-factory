---
name: test-authoring
stages:
  triage: {}
  plan:
    needs: triage
  build:
    needs: plan
    gates: [unit]
  verify:
    needs: build
  pr:
    needs: verify
---
Write the missing tests for the code this issue names, and change no product code. The plan lists
each behaviour to pin and the test file it goes in; the build is held to the unit gate, and verify
rejects a test that passes without the code it claims to cover.
