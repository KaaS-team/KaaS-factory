import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AI_TRAILER, applySignoff, commitsProblems } from "../src/commit-signoff";
import { mergeConfig } from "../src/config";
import { GitCommandRunner, withSignoff } from "../src/git";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const who = { name: "Dev One", email: "dev@example.com" };
const req = { name: "Req Two", email: "req@example.com" };

async function fixture(runner: GitCommandRunner): Promise<string> {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "factory-signoff-"));
  dirs.push(dir);
  const sh = (a: string[]) => runner.run(a, { cwd: dir });
  await sh(["init", "-q"]);
  await sh(["config", "user.name", who.name]);
  await sh(["config", "user.email", who.email]);
  const tree = (await sh(["write-tree"])).stdout.trim();
  const sha = (await sh(["commit-tree", tree, "-m", "claim"])).stdout.trim();
  return (await sh(["log", "-1", "--format=%B", sha])).stdout;
}

describe("commits.signoff", () => {
  test("unset is byte-identical to withSignoff", async () => {
    const body = await fixture(new GitCommandRunner());
    expect(body.trimEnd()).toBe(withSignoff(["-m", "claim"], who)[1]!);
    expect(applySignoff(["commit-tree", "-m", "x"], "human", who)[2]).toBe(
      `x\n\nSigned-off-by: Dev One <dev@example.com>\n${AI_TRAILER}`,
    );
  });

  test("human signs as the committer and credits the requester", async () => {
    const body = await fixture(new GitCommandRunner({ mode: "human", requester: req }));
    expect(body.trimEnd()).toBe(
      `claim\n\nSigned-off-by: Dev One <dev@example.com>\nCo-authored-by: Req Two <req@example.com>\n${AI_TRAILER}`,
    );
  });

  test("bot signs as the factory", async () => {
    const body = await fixture(new GitCommandRunner({ mode: "bot", requester: req }));
    expect(body.trimEnd()).toBe(
      `claim\n\nSigned-off-by: kaas-factory <factory@users.noreply.github.com>\nCo-authored-by: Req Two <req@example.com>\n${AI_TRAILER}`,
    );
  });

  test("none adds no trailers", async () => {
    expect((await fixture(new GitCommandRunner({ mode: "none", requester: req }))).trimEnd()).toBe("claim");
  });

  test("config validates the enum and defaults to unset", () => {
    expect(commitsProblems({ signoff: "robot" })).toEqual([
      'commits.signoff: expected one of human, bot, none, got "robot"',
    ]);
    expect(commitsProblems({ signoff: "bot" })).toEqual([]);
    expect(mergeConfig({}).commits?.signoff).toBe(undefined);
  });
});
