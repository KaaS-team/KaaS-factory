// The MCP server is its own package. The core starts it by name and runs without it; its tool
// names and behaviour are pinned by tests/mcp-server.test.ts.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { copyRepo } from "../scripts/repo-copy";
import { MCP_PACKAGE } from "../src/remote-cli";

const ROOT = resolve(import.meta.dir, "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (n === "node_modules") return [];
    return statSync(p).isDirectory() ? walk(p) : /\.(ts|js)$/.test(n) || dir.endsWith("bin") ? [p] : [];
  });
}

describe("mcp server package", () => {
  test("it is a workspace package that exports the server", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "packages", "mcp-server", "package.json"), "utf8"));
    expect(pkg.name).toBe(MCP_PACKAGE);
    expect(pkg.private).toBe(true);
    const mod = await import(MCP_PACKAGE);
    expect(typeof mod.createMcpServer).toBe("function");
    expect(typeof mod.serveStdio).toBe("function");
  });

  test("the core (src/ and bin/) imports nothing from the mcp server package", () => {
    const hits = ["src", "bin"]
      .flatMap((d) => walk(join(ROOT, d)))
      .filter((f) =>
        /(?:from\s+|import\s*\(\s*|import\s+)["'][^"']*(factory-mcp-server|packages\/mcp-server)/.test(
          readFileSync(f, "utf8"),
        ),
      );
    expect(hits).toEqual([]);
  });

  test("the core runs without the package, and `mcp` says what is missing", () => {
    const dir = copyRepo(ROOT, "factory-nomcp-");
    try {
      rmSync(join(dir, "packages", "mcp-server"), { recursive: true });
      const run = (...args: string[]) =>
        Bun.spawnSync(["bun", join(dir, "bin", "factory"), ...args], {
          cwd: dir,
          env: { ...process.env, FACTORY_HOME: join(dir, "home") },
        });
      expect(run("help").exitCode).toBe(0);
      const mcp = run("mcp", "--repo", "a/b");
      expect(mcp.exitCode).not.toBe(0);
      expect(mcp.stderr.toString()).toContain(`mcp: ${MCP_PACKAGE} is not installed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
