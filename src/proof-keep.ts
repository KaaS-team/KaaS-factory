// What the revert proof leaves alone (#161). The proof puts the base version of every source
// file back and runs the test gate. If the diff itself adds the gate, reverting the Makefile
// that runs the tests means no test runs and the proof wrongly reads "passes without the change".

const GATE_FILE = /^(GNUmakefile|[Mm]akefile|justfile|Justfile|Taskfile\.ya?ml)$/;

// A build file at any depth that only runs the tests, never the code they cover.
export function isGateFile(path: string): boolean {
  return GATE_FILE.test(path.split("/").pop() ?? "");
}

// Output of a runner that found nothing to run: bun, jest, vitest, pytest, go, make, rspec.
const ZERO_TESTS = [
  /^\s*0 pass\b/m,
  /No tests found/i,
  /no tests ran/i,
  /no test files/i,
  /No rule to make target/i,
  /0 examples, 0 failures/,
  /Ran 0 tests/,
];

export function ranZeroTests(output: string): boolean {
  return ZERO_TESTS.some((re) => re.test(output));
}
