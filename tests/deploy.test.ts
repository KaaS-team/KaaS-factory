// The deploy shape: one image for plane, relay and verify, `docker compose up` to self-host, and
// `kaas-factory up` on a laptop running the same stack, idle under the memory budget.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IDLE_RSS_BUDGET_MB, treeRssKb } from "../src/deploy/rss";
import { relaySettings } from "../src/deploy/stack";

const ROOT = join(import.meta.dir, "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
// The same target directory as tests/relay.test.ts, so the relay is built once per checkout.
const TARGET = join(
  process.env.CARGO_TARGET_DIR ?? join(tmpdir(), "kaas-relay-target"),
  createHash("sha256").update(ROOT).digest("hex").slice(0, 12),
);
const RELAY = join(TARGET, "release", "kaas-relay");

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
}

async function until(ok: () => Promise<boolean>, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(200))
    if (await ok().catch(() => false)) return true;
  return false;
}

describe("one image", () => {
  test("the image builds the relay and verify, carries both, and runs the stack by default", () => {
    const docker = read("Dockerfile");
    expect(docker).toContain("--manifest-path relay/Cargo.toml");
    expect(docker).toContain("--manifest-path verify/Cargo.toml");
    expect(docker).toMatch(
      /^COPY --from=rust \/out\/release\/kaas-relay \/out\/release\/kaas-verify \/usr\/local\/bin\/$/m,
    );
    expect(docker).toMatch(/^CMD \["up"\]$/m);
    // The health probes call curl, so it must survive the purge of build-only tools.
    expect(docker).not.toMatch(/apt-get purge[^\n]*\bcurl\b/);

    const compose = read("docker-compose.yml");
    expect(compose).toContain('command: ["up"]');
    expect(compose).toContain("FACTORY_HOME: /data");
    expect(compose).toContain("- factory-data:/data");
    expect(compose).toContain("http://127.0.0.1:4100/health");

    const pkg = JSON.parse(read("package.json")) as { name: string; bin: Record<string, string> };
    expect(pkg.bin[pkg.name]).toBe("./bin/factory");
  });
});

describe("relay settings", () => {
  test("FACTORY_RELAY_* wins over KAAS_RELAY_*", () => {
    const env = {
      FACTORY_RELAY_BIN: "/new/kaas-relay",
      KAAS_RELAY_BIN: "/old/kaas-relay",
      FACTORY_RELAY_ADDR: "10.0.0.2:1",
      KAAS_RELAY_ADDR: "10.0.0.1:9",
      FACTORY_RELAY_PUBLISH_TOKEN: "new-publish-token-16",
      KAAS_RELAY_PUBLISH_TOKEN: "old-publish-token-16",
      FACTORY_RELAY_SUBSCRIBE_TOKEN: "new-subscribe-token-16",
      KAAS_RELAY_SUBSCRIBE_TOKEN: "old-subscribe-token-16",
    };
    expect(relaySettings(env)).toEqual({
      bin: "/new/kaas-relay",
      addr: "10.0.0.2:1",
      publish: "new-publish-token-16",
      subscribe: "new-subscribe-token-16",
    });
  });

  test("KAAS_RELAY_* alone is still read", () => {
    expect(
      relaySettings({
        KAAS_RELAY_BIN: "/old/kaas-relay",
        KAAS_RELAY_ADDR: "10.0.0.1:9",
        KAAS_RELAY_PUBLISH_TOKEN: "old-publish-token-16",
        KAAS_RELAY_SUBSCRIBE_TOKEN: "old-subscribe-token-16",
      }),
    ).toEqual({
      bin: "/old/kaas-relay",
      addr: "10.0.0.1:9",
      publish: "old-publish-token-16",
      subscribe: "old-subscribe-token-16",
    });
  });

  test("with neither, the address defaults and the tokens are unset", () => {
    expect(relaySettings({})).toEqual({
      bin: undefined,
      addr: "127.0.0.1:4200",
      publish: undefined,
      subscribe: undefined,
    });
  });
});

describe("one image carries ee", () => {
  test("the image carries ee/ without its tests and fixtures", () => {
    expect(read("Dockerfile")).toContain("COPY template-ci ./template-ci\nCOPY ee ./ee\n");
    const ignored = read(".dockerignore").split("\n");
    expect(ignored).toContain("ee/tests");
    expect(ignored).toContain("ee/fixtures");
  });

  // Runs the real entrypoint with a stub `bun` that prints its argv.
  function entrypoint(opts: { ee: boolean; env?: Record<string, string> }, ...args: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), "factory-entry-"));
    const stubs = join(dir, "stubs");
    mkdirSync(stubs);
    writeFileSync(join(stubs, "bun"), '#!/bin/sh\necho "bun $*"\n');
    chmodSync(join(stubs, "bun"), 0o755);
    const cwd = join(dir, "app");
    mkdirSync(join(cwd, "ee"), { recursive: true });
    if (opts.ee) writeFileSync(join(cwd, "ee/register.ts"), "");
    const run = Bun.spawnSync(["bash", join(ROOT, "docker-entrypoint.sh"), ...args], {
      cwd,
      env: { PATH: `${stubs}:${process.env.PATH ?? ""}`, ...opts.env },
    });
    expect(run.exitCode).toBe(0);
    return run.stdout.toString().trim();
  }

  test("the entrypoint preloads ee/register.ts unless FACTORY_EE=0 or ee is absent", () => {
    expect(entrypoint({ ee: true }, "up", "--x")).toBe("bun --preload ./ee/register.ts bin/factory up --x");
    expect(entrypoint({ ee: true, env: { FACTORY_EE: "0" } }, "up")).toBe("bun bin/factory up");
    expect(entrypoint({ ee: false }, "up")).toBe("bun bin/factory up");
  });
});

describe("kaas-factory up with no repo", () => {
  let proc: ReturnType<typeof Bun.spawn>;
  let plane = "";
  let relay = "";

  beforeAll(async () => {
    const built = Bun.spawnSync(
      ["cargo", "build", "--release", "--locked", "--quiet", "--manifest-path", join(ROOT, "relay/Cargo.toml")],
      { stderr: "pipe", env: { ...process.env, CARGO_TARGET_DIR: TARGET } },
    );
    if (built.exitCode !== 0) throw new Error(`cargo build of relay/ failed: ${built.stderr.toString()}`);
    const [planePort, relayPort] = [freePort(), freePort()];
    plane = `http://127.0.0.1:${planePort}`;
    relay = `http://127.0.0.1:${relayPort}`;
    proc = Bun.spawn(["bun", join(ROOT, "bin/factory"), "up"], {
      cwd: mkdtempSync(join(tmpdir(), "factory-up-cwd-")),
      env: {
        PATH: process.env.PATH ?? "",
        HOME: mkdtempSync(join(tmpdir(), "factory-up-home-")),
        FACTORY_HOME: mkdtempSync(join(tmpdir(), "factory-up-")),
        FACTORY_DASHBOARD_PORT: String(planePort),
        KAAS_RELAY_ADDR: `127.0.0.1:${relayPort}`,
        KAAS_RELAY_BIN: RELAY,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const up = await until(async () => (await fetch(`${plane}/health`)).ok, 20_000);
    if (!up)
      throw new Error(`the stack never answered /health: ${await new Response(proc.stderr as ReadableStream).text()}`);
  }, 300_000);

  afterAll(() => proc?.kill());

  test("serves /health and starts the relay beside the plane", async () => {
    expect(await (await fetch(`${plane}/health`)).json()).toEqual({
      ok: true,
      service: "kaas-factory",
      version: JSON.parse(read("package.json")).version,
    });
    expect(await until(async () => (await fetch(`${relay}/healthz`, { keepalive: false })).ok, 5_000)).toBe(true);
  });

  test("idle RSS of plane plus relay stays under 150 MB", async () => {
    await Bun.sleep(3_000);
    const mb = treeRssKb(proc.pid) / 1024;
    console.log(`idle RSS, plane plus relay: ${mb.toFixed(1)} MB`);
    expect(mb).toBeGreaterThan(0);
    expect(IDLE_RSS_BUDGET_MB).toBe(150);
    expect(mb).toBeLessThan(IDLE_RSS_BUDGET_MB);
  }, 15_000);
});
