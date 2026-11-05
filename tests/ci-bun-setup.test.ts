import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

// A runner image has no bun, so a job that runs bun before setup-bun exits 127.
export function jobsRunningBunUnset(text: string): string[] {
  const bad: string[] = [];
  let job: string | undefined;
  let ready = false;
  let inJobs = false;
  for (const line of text.split("\n")) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const head = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (head) {
      job = head[1];
      ready = false;
      continue;
    }
    if (job === undefined) continue;
    if (line.includes("oven-sh/setup-bun@")) ready = true;
    else if (
      !ready &&
      /(^|[\s|;&(])(bun|bunx)\s/.test(line.replace(/^\s*-?\s*run:\s*/, " ")) &&
      !line.trim().startsWith("#")
    ) {
      if (!bad.includes(job)) bad.push(job);
    }
  }
  return bad;
}

const dirs = [join(ROOT, ".github", "workflows"), join(ROOT, "ci"), join(ROOT, "template", ".github", "workflows")];
const files = dirs.filter(existsSync).flatMap((d) =>
  readdirSync(d)
    .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
    .map((f) => join(d, f)),
);

test("every workflow job sets up bun before it runs bun", () => {
  expect(files.length).toBeGreaterThan(0);
  const bad = files.flatMap((f) =>
    jobsRunningBunUnset(readFileSync(f, "utf8")).map((j) => `${f.slice(ROOT.length + 1)}: ${j}`),
  );
  expect(bad).toEqual([]);
});

test("a job that runs bun with no setup step is caught", () => {
  const wf =
    "jobs:\n  a:\n    steps:\n      - uses: oven-sh/setup-bun@v2\n      - run: bun x tsc\n  b:\n    steps:\n      - run: bun scripts/x.ts\n";
  expect(jobsRunningBunUnset(wf)).toEqual(["b"]);
});
