# The suite may not grow, slow down or keep scaffold tests without a reason (scripts/suite-ratchet.ts).
# It reads the junit report make test just wrote, so it runs after test in make check.
check-suite-ratchet:
	bun scripts/suite-ratchet.ts --runtime reports/junit.xml

CHECK_EXTRA += check-suite-ratchet
.PHONY: check-suite-ratchet
