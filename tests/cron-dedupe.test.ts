// Two watchers on one repo, each with its own state, both see the same scheduled minute. A claim on
// the shared lease store (refs on the repo's own remote in production) lets exactly one file it.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitLeases } from "../src/adapters/git-lease/lease";
import { cronStore, fireCron } from "../src/engine/triggers";
import { parseWorkflowText } from "../src/engine/workflows";
import type { LeasePort } from "../src/ports/lease";
import { FakeGitHub, FakeLeases } from "./harness";

const root = mkdtempSync(join(tmpdir(), "factory-cron-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const nightly = (() => {
  const r = parseWorkflowText(`name: nightly
on:
  cron:
    - schedule: "0 2 * * *"
      title: Nightly dependency check
steps:
  triage:
    uses: triage
    label: factory:triaging
    next: pr
  pr:
    uses: pr
    label: factory:in-review
`);
  if (!r.ok) throw new Error(r.problems.join("; "));
  return r.workflow;
})();

class Store {
  kv = new Map<string, string>();
  getSetting = (k: string) => this.kv.get(k);
  setSetting = (k: string, v: string) => void this.kv.set(k, v);
}

// GitHub's issue list lags its writes, so the open-issue marker check alone cannot see a twin.
class LaggingGitHub extends FakeGitHub {
  override async listOpenIssues() {
    return [];
  }
}

// Both watchers last looked a minute before 02:00 and look again just after it, at once or one
// after the other.
async function twoWatchers(
  port: (n: number) => LeasePort,
  together = true,
): Promise<{ gh: FakeGitHub; filed: number[][] }> {
  const gh = new LaggingGitHub([]);
  const stores = [new Store(), new Store()];
  for (const s of stores) await fireCron(gh, s, "o/r", nightly, new Date("2026-10-09T01:59:00Z"));
  if (!together) {
    const filed: number[][] = [];
    for (const [n, state] of stores.entries())
      filed.push(
        await fireCron(
          gh,
          cronStore({ state, leases: { port: port(n), holder: `w${n}` } }),
          "o/r",
          nightly,
          new Date("2026-10-09T02:00:30Z"),
        ),
      );
    return { gh, filed };
  }
  const filed = await Promise.all(
    stores.map((state, n) =>
      fireCron(
        gh,
        cronStore({ state, leases: { port: port(n), holder: `w${n}` } }),
        "o/r",
        nightly,
        new Date("2026-10-09T02:00:30Z"),
      ),
    ),
  );
  return { gh, filed };
}

describe("cron dedupe", () => {
  test("two watchers sharing a lease store file one scheduled issue between them", async () => {
    const leases = new FakeLeases();
    const { gh, filed } = await twoWatchers(() => leases);
    expect(filed.flat()).toHaveLength(1);
    expect(gh.issues.size).toBe(1);
  });

  // Run together the push's compare-and-swap decides; one after the other the lease the first left does.
  test("two watchers on clones of one remote file one scheduled issue through git lease refs", async () => {
    for (const together of [true, false]) {
      const remote = join(root, `origin-${together}.git`);
      Bun.spawnSync(["git", "init", "-q", "--bare", remote]);
      const clone = (n: number) => {
        const dir = join(root, `w${n}-${together}`);
        Bun.spawnSync(["git", "init", "-q", dir]);
        Bun.spawnSync(["git", "remote", "add", "origin", remote], { cwd: dir });
        return new GitLeases(dir);
      };
      const ports = [clone(0), clone(1)];
      const { gh, filed } = await twoWatchers((n) => ports[n]!, together);
      expect(filed.flat()).toHaveLength(1);
      expect(gh.issues.size).toBe(1);
      const refs = Bun.spawnSync(["git", "for-each-ref", "--format=%(refname)", "refs/factory/lease"], { cwd: remote });
      expect(refs.stdout.toString().trim()).toBe("refs/factory/lease/cron.nightly.0.29858520");
    }
  });
});
