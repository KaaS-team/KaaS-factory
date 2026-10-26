// The factory runs on a laptop and on a server from the same code: the image holds every file the CLI
// and the dashboard import, so `docker run` cannot fail on a module that only the checkout has.
import { describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { daemonPlatform } from "../src/daemon";

const root = resolve(import.meta.dir, "..");
const copied = [...readFileSync(join(root, "Dockerfile"), "utf8").matchAll(/^COPY (\S+) \.\/(\S+)$/gm)].map(
  (m) => m[1]!,
);

// Every repo file reachable from the entrypoints, dynamic imports included.
function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const ts = new Bun.Transpiler({ loader: "ts" });
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const { path } of ts.scanImports(readFileSync(file, "utf8").replace(/^#!.*/, ""))) {
      if (!path.startsWith(".")) continue;
      const base = resolve(dirname(file), path);
      const hit = [base, `${base}.ts`, `${base}.js`, join(base, "index.ts")].find(
        (p) => existsSync(p) && statSync(p).isFile(),
      );
      if (hit) walk(hit);
    }
  };
  for (const e of entries) walk(join(root, e));
  return seen;
}

describe("local or server", () => {
  test("the image copies every file the CLI and dashboard load, and runs from that copy alone", () => {
    const files = [...reachable(["bin/factory", "dashboard/server.ts"])].map((f) => relative(root, f));
    expect(files.length).toBeGreaterThan(20);
    const outside = files.filter((f) => !copied.some((c) => f === c || f.startsWith(`${c}/`)));
    expect(outside).toEqual([]);
    // Built the way the Dockerfile builds it: only what it COPYs, beside the installed packages.
    const image = mkdtempSync(join(tmpdir(), "factory-image-"));
    for (const c of [...copied, "package.json"]) cpSync(join(root, c), join(image, c), { recursive: true });
    symlinkSync(join(root, "node_modules"), join(image, "node_modules"));
    const help = Bun.spawnSync([process.execPath, "bin/factory", "--help"], { cwd: image, stderr: "pipe" });
    expect(help.stderr.toString()).toBe("");
    expect(help.exitCode).toBe(0);
    const dash = Bun.spawnSync([process.execPath, "-e", 'await import("./dashboard/server.ts")'], { cwd: image });
    expect(dash.exitCode).toBe(0);
    // On a machine without Docker, the same CLI installs itself as a launchd or systemd service.
    expect([daemonPlatform("darwin"), daemonPlatform("linux")]).toEqual(["launchd", "systemd"]);
  });
});
