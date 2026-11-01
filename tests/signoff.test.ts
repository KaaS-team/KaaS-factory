import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configProblems } from "../src/config";
import { GitCommandRunner, withSignoff } from "../src/git";

const ME = { name: "Test Author", email: "test@example.com" };
const SIGNED = "Signed-off-by: Test Author <test@example.com>";
const CO = "Co-authored-by: Rae Quester <rae@example.com>";
const AI = "Assisted-by: KaaS Factory";

async function commitBody(
  commits: ConstructorParameters<typeof GitCommandRunner>[0],
): Promise<{ body: string; sha: string }> {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "signoff-"));
  try {
    const run = (a: string[], env?: Record<string, string>) => new GitCommandRunner(commits).run(a, { cwd: dir, env });
    await run(["init", "-q"]);
    await run(["config", "user.name", ME.name]);
    await run(["config", "user.email", ME.email]);
    const tree = (await run(["hash-object", "-t", "tree", "-w", "--stdin"])).stdout.trim();
    const env = { GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z" };
    const sha = (await run(["commit-tree", tree, "-m", "subject"], env)).stdout.trim();
    const body = (await run(["log", "-1", "--format=%B", sha])).stdout.trimEnd();
    return { body, sha };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("commits.signoff", () => {
  test("unset is byte-identical to today's single Signed-off-by", async () => {
    const { body } = await commitBody({});
    expect(body).toBe(`subject\n\n${SIGNED}`);
    expect(withSignoff(["-m", "subject"], ME)).toEqual(["-m", `subject\n\n${SIGNED}`]);
  });

  test("human adds the requester as co-author", async () => {
    expect(
      (await commitBody({ signoff: "human", requester: { name: "Rae Quester", email: "rae@example.com" } })).body,
    ).toBe(`subject\n\n${SIGNED}\n${CO}`);
  });

  test("bot adds the AI-assistance trailer after the co-author", async () => {
    expect(
      (await commitBody({ signoff: "bot", requester: { name: "Rae Quester", email: "rae@example.com" } })).body,
    ).toBe(`subject\n\n${SIGNED}\n${CO}\n${AI}`);
  });

  test("none leaves the message bare", async () => {
    expect((await commitBody({ signoff: "none" })).body).toBe("subject");
  });

  test("config accepts the three modes and refuses a typo", () => {
    for (const m of ["human", "bot", "none"]) expect(configProblems({ commits: { signoff: m } })).toEqual([]);
    expect(configProblems({ commits: { signoff: "robot" } })).toEqual([
      'commits.signoff: expected one of human, bot, none, got "robot"',
    ]);
  });
});
