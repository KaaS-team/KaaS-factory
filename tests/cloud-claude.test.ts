import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCloudProvider } from "../src/cloud/claude";

const prompt = "build the feature\nwith details";

describe("claude cloud command adapter", () => {
  test("prompt by file", async () => {
    mkdirSync(tmpdir(), { recursive: true });
    const dir = mkdtempSync(join(tmpdir(), "cloud-claude-"));
    const runs: { argv: string[] }[] = [];
    let captured = "";
    const p = claudeCloudProvider({
      launch: ["claude-cloud", "launch", "--prompt", "{promptFile}", "--branch", "{branch}", "--repo", "{repo}"],
      status: ["claude-cloud", "status", "{session}"],
      cancel: ["claude-cloud", "cancel", "{session}"],
      tmpDir: dir,
      run: async (argv) => {
        runs.push({ argv });
        const pathArg = argv.find((a) => a.startsWith(dir));
        if (pathArg) captured = readFileSync(pathArg, "utf8");
        return { code: 0, stdout: '{"id":"sess-1"}\n' };
      },
    });
    await p.launch({
      repoUrl: "https://github.com/o/r",
      branch: "feat/a",
      prompt,
      model: "opus",
      key: "k",
      title: "t",
    });
    for (const r of runs) {
      for (const a of r.argv) expect(a.includes(prompt)).toBe(false);
    }
    expect(captured).toBe(prompt);
  });

  test("poll maps status json", async () => {
    const p = claudeCloudProvider({
      launch: ["x"],
      status: ["status", "{session}"],
      cancel: ["cancel", "{session}"],
      run: async (_argv) => ({ code: 0, stdout: '{"status":"finished","prUrl":"https://github.com/o/r/pull/1"}\n' }),
    });
    const run = await p.poll("sess-1");
    expect(run.status).toBe("finished");
    expect(run.prUrl).toBe("https://github.com/o/r/pull/1");
  });

  test("empty launch argv rejects all calls", async () => {
    const p = claudeCloudProvider({ launch: [], status: [], cancel: [] });
    let msg = "";
    try {
      await p.launch({ repoUrl: "r", branch: "b", prompt: "p", model: "m", key: "k", title: "t" });
    } catch (e) {
      msg = String(e instanceof Error ? e.message : e);
    }
    expect(msg).toBe("claude-cloud has no launch command configured");
  });
});
