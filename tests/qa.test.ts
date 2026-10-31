// The QA step: qa.sh requests the plan's routes and writes qa.json; the PR body renders it (src/qa.ts).
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prBody } from "../src/engine/pr-body";
import { qaSection, readQa } from "../src/qa";

// The per-run temp parent can be gone on a rerun, so it is recreated before each mkdtemp.
const scratch = (prefix: string) => {
  mkdirSync(tmpdir(), { recursive: true });
  return mkdtempSync(join(tmpdir(), prefix));
};

const tmp = () => scratch("factory-qa-");

describe("qa section", () => {
  test("a qa.json with one failed route renders a QA section with that route failed", () => {
    const dir = tmp();
    try {
      mkdirSync(join(dir, ".factory/runs/issue-7"), { recursive: true });
      writeFileSync(
        join(dir, ".factory/runs/issue-7/qa.json"),
        JSON.stringify({
          routes: [
            { path: "/", status: 200, ok: true },
            { path: "/missing", status: 404, ok: false },
          ],
        }),
      );
      const qa = readQa(dir, 7)!;
      expect(qaSection(qa)).toContain("| `/missing` | 404 | failed |");
      expect(qaSection(qa)).toContain("| `/` | 200 | ok |");
      expect(prBody("body", { qa })).toContain("## QA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  test("no qa.json, no section", () => {
    const dir = tmp();
    try {
      expect(readQa(dir, 7)).toBeUndefined();
      expect(prBody("body", { qa: readQa(dir, 7) })).not.toContain("## QA");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("qa.sh", () => {
  test("against a tiny fixture server it writes the routes and stops the server", async () => {
    const dir = tmp();
    try {
      const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
      const port = probe.port;
      probe.stop(true);
      writeFileSync(
        join(dir, "app.ts"),
        `Bun.serve({ port: ${port}, fetch: (r) => new Response("x", { status: new URL(r.url).pathname === "/bad" ? 500 : 200 }) });`,
      );
      mkdirSync(join(dir, ".factory/runs/issue-9"), { recursive: true });
      writeFileSync(join(dir, ".factory/runs/issue-9/plan.json"), JSON.stringify({ routes: ["/", "/bad"] }));
      const run = (cmd: string[]) =>
        Bun.spawnSync(cmd, {
          cwd: dir,
          env: {
            ...process.env,
            QA_COMMAND: `bun ${join(dir, "app.ts")}`,
            QA_URL: `http://127.0.0.1:${port}`,
            FACTORY_ISSUE: "9",
          },
        });
      Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      const res = run(["bash", join(import.meta.dir, "../template/.factory/qa.sh")]);
      expect(res.exitCode).toBe(1);
      const qa = JSON.parse(readFileSync(join(dir, ".factory/runs/issue-9/qa.json"), "utf8"));
      expect(qa.routes).toEqual([
        { path: "/", status: 200, ok: true },
        { path: "/bad", status: 500, ok: false },
      ]);
      await Bun.sleep(300);
      await expect(fetch(`http://127.0.0.1:${port}/`)).rejects.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
