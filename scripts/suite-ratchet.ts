// The test suite may not grow without a reason. tests/suite-ratchet.json holds three ceilings: the
// number of test cases, the number titled @scaffold (a scaffold test is pruned or graduated, so 0), and
// the run time of `make test` read from its junit report. Raising a ceiling means adding a `growth`
// entry whose `tests` equals the new ceiling and whose `reason` says why.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface Ratchet {
  tests: number;
  scaffold: number;
  runtimeSeconds: number;
  growth: { tests: number; reason: string }[];
}
export interface Suite {
  tests: number;
  scaffold: number;
}

const CASE = /^\s*(?:test|it)(?:\.[a-z]+)*\(\s*(["'`])(.*?)\1/;

export function countSuite(sources: readonly string[]): Suite {
  const suite = { tests: 0, scaffold: 0 };
  for (const src of sources)
    for (const line of src.split("\n")) {
      const m = CASE.exec(line);
      if (!m) continue;
      suite.tests += 1;
      if (m[2]!.includes("@scaffold")) suite.scaffold += 1;
    }
  return suite;
}

// The seconds `bun test --reporter=junit` wrote on its root element.
export function junitSeconds(xml: string): number | undefined {
  const m = /<testsuites\b[^>]*\btime="([0-9.]+)"/.exec(xml);
  return m ? Number(m[1]) : undefined;
}

export function ratchetProblems(suite: Suite, base: Ratchet, seconds?: number): string[] {
  const out: string[] = [];
  const last = base.growth[base.growth.length - 1];
  if (!last || last.tests !== base.tests || !last.reason.trim())
    out.push(`the test ceiling ${base.tests} has no growth entry with a reason`);
  if (suite.tests > base.tests)
    out.push(`the suite has ${suite.tests} tests, over the ceiling of ${base.tests}: prune, or raise it with a reason`);
  if (suite.scaffold > base.scaffold)
    out.push(`${suite.scaffold} tests are titled @scaffold: graduate each (drop the tag) or delete it`);
  if (seconds !== undefined && seconds > base.runtimeSeconds)
    out.push(`the suite took ${seconds.toFixed(0)}s, over the ceiling of ${base.runtimeSeconds}s`);
  return out;
}

function testSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "fixtures" ? [] : testSources(p);
    return e.name.endsWith(".test.ts") ? [readFileSync(p, "utf8")] : [];
  });
}

if (import.meta.main) {
  const base = JSON.parse(readFileSync("tests/suite-ratchet.json", "utf8")) as Ratchet;
  const at = process.argv.indexOf("--runtime");
  const report = at > 0 ? process.argv[at + 1] : undefined;
  if (report && !existsSync(report)) {
    console.error(`suite-ratchet: ${report} is missing; run make test first`);
    process.exit(1);
  }
  const seconds = report ? junitSeconds(readFileSync(report, "utf8")) : undefined;
  if (report && seconds === undefined) {
    console.error(`suite-ratchet: ${report} has no run time`);
    process.exit(1);
  }
  const suite = countSuite(testSources("tests"));
  const problems = ratchetProblems(suite, base, seconds);
  for (const p of problems) console.error(`suite-ratchet: ${p}`);
  if (problems.length > 0) process.exit(1);
  console.log(`suite-ratchet: ok (${suite.tests} tests, ceiling ${base.tests})`);
}
