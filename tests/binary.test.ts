import { describe, expect, test } from "bun:test";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TARGETS, embeddedFiles, hostTarget } from "../scripts/build-binary";

const root = join(import.meta.dir, "..");

describe("host binary", () => {
  test("prints the version, runs init and install --ci outside the repo", () => {
    const tmp = mkdtempSync(join(tmpdir(), "factory-binary-"));
    const build = Bun.spawnSync(["bun", join(root, "scripts", "build-binary.ts"), "--host", "--out", tmp], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(build.stderr.toString() + build.stdout.toString()).toContain("build-binary:");
    expect(build.exitCode).toBe(0);
    const [, os, arch] = hostTarget().split("-");
    const bin = join(tmp, `factory-${os}-${arch}`);
    const home = join(tmp, "home");
    mkdirSync(home);
    const run = (...args: string[]) =>
      Bun.spawnSync([bin, ...args], {
        cwd: tmp,
        env: { ...process.env, FACTORY_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      });

    const version = run("--version");
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);

    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const init = run("init", "--repo-dir", repo);
    expect(init.stderr.toString()).toBe("");
    expect(init.exitCode).toBe(0);
    for (const key of Object.keys(embeddedFiles()).filter((k) => k.startsWith("template/")))
      expect(existsSync(join(repo, key.slice("template/".length)))).toBe(true);
    expect(() => accessSync(join(repo, ".factory", "gates.sh"), constants.X_OK)).not.toThrow();
    expect(existsSync(join(repo, ".factory", "config.json"))).toBe(true);

    const ciRepo = join(tmp, "ci-repo");
    mkdirSync(ciRepo);
    const ci = run("install", ciRepo, "--ci");
    expect(ci.exitCode).toBe(0);
    expect(existsSync(join(ciRepo, ".github", "workflows", "factory.yml.example"))).toBe(true);
  }, 120_000);
});

describe("release workflow", () => {
  test("builds exactly TARGETS", () => {
    const text = readFileSync(join(root, ".github", "workflows", "release-binaries.yml"), "utf8");
    const listed = [...text.matchAll(/^\s*-\s+(bun-\S+)\s*$/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual([...TARGETS].sort());
    expect(TARGETS as readonly string[]).toContain(hostTarget());
  });

  test("a tag publishes the binaries with SHA256SUMS", () => {
    const text = readFileSync(join(root, ".github", "workflows", "release-binaries.yml"), "utf8");
    expect(text).toContain("sha256sum factory-* > SHA256SUMS");
    expect(text).toContain("gh release upload");
    expect(text).toContain("startsWith(github.ref, 'refs/tags/v')");
    expect(text).not.toContain("Staged outside");
  });
});
