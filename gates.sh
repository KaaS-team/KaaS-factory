#!/bin/sh
# Runs go test, then prints one FACTORY_GATES line; the runner keeps the output tail.
if go test ./... 2>&1; then
  echo "FACTORY_GATES: status=GREEN passed=1 failed=0 skipped=0 failed_gates=-"
else
  echo "FACTORY_GATES: status=RED passed=0 failed=1 skipped=0 failed_gates=go-test"
fi
