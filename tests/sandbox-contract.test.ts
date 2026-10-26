// The sandbox contract, the shared conformance kit every runtime must pass, the default runtime
// and the live health probe (docs/runtimes.md#the-sandbox-contract).

import { describe, expect, test } from "bun:test";
import { HttpSandboxExecution } from "../src/adapters/http-sandbox/execution";
import { LocalExecution } from "../src/adapters/local/execution";
import { WrapExecution } from "../src/adapters/wrap/execution";
import type { ExecutionPort } from "../src/ports/execution";
import { SandboxUnsupported } from "../src/ports/sandbox";
import { probeRuntime, verifyRuntime } from "../src/runtime-kit";
import {
  DEFAULT_RUNTIME,
  DEFAULT_VM,
  defaultRuntime,
  RUNTIME_KINDS,
  runtimeProblems,
  runtimesFrom,
} from "../src/runtimes";
import { CAPABILITIES, sandboxProvider } from "../src/sandbox";
import { startSandbox } from "./fixtures/http-sandbox";

const failed = (checks: { name: string; ok: boolean }[]) => checks.filter((c) => !c.ok).map((c) => c.name);

describe("sandbox contract", () => {
  test("every runtime kind reports its flags, and a sandbox does each verb", async () => {
    expect(Object.keys(CAPABILITIES).sort()).toEqual([...RUNTIME_KINDS].sort());
    for (const c of Object.values(CAPABILITIES))
      expect(Object.keys(c).sort()).toEqual(["byo", "egress", "expose", "isolation", "memoryResume", "snapshot"]);
    const provider = sandboxProvider(new LocalExecution(), CAPABILITIES.local);
    const box = await provider.create({ env: { WHO: "it's me" } });
    await box.files.put("a/b.txt", "one");
    expect((await box.exec('cat a/b.txt; echo " $WHO"')).stdout).toBe("one it's me\n");
    expect(await box.files.list("a")).toEqual(["b.txt"]);
    await expect(box.files.get("../../etc/passwd")).rejects.toThrow("outside the sandbox");
    const snap = await box.snapshot();
    expect(await box.pause()).toEqual({ memoryKept: false });
    await expect(box.exec("echo no")).rejects.toThrow("paused");
    await box.resume();
    expect((await box.exec("echo yes")).stdout).toBe("yes\n");
    await expect(box.expose(3000)).rejects.toBeInstanceOf(SandboxUnsupported);
    await box.destroy();
    expect(await box.status()).toBe("destroyed");
    const restored = await provider.create({ snapshot: snap });
    expect(new TextDecoder().decode(await restored.files.get("a/b.txt"))).toBe("one");
    await expect(provider.create({ env: { "A;rm": "x" } })).rejects.toThrow("not an env var name");
  });
});

describe("runtime verify", () => {
  test("the kit passes a working runtime and names what a broken one gets wrong", async () => {
    expect(failed(await verifyRuntime(new LocalExecution(), CAPABILITIES.local))).toEqual([]);
    const liar: ExecutionPort = { run: async () => ({ stdout: "kit-42 kit-out", stderr: "", code: 0 }) };
    expect(failed(await verifyRuntime(liar, CAPABILITIES.local))).toEqual([
      "passes the command's exit code through",
      "keeps stderr apart from stdout",
      "runs in the sandbox's files, with its env",
      "a snapshot restores into a new sandbox",
      "pause refuses commands until resume, and says whether memory was kept",
    ]);
  });

  test("any sandbox passes the same kit: an http sandbox and a wrap launcher, not only microsandbox", async () => {
    const server = startSandbox("kit-token");
    try {
      const http = new HttpSandboxExecution(
        { kind: "http", url: server.url, tokenEnv: "KIT_TOKEN" },
        { KIT_TOKEN: "kit-token" },
      );
      expect(failed(await verifyRuntime(http, CAPABILITIES.http))).toEqual([]);
    } finally {
      server.stop();
    }
    const wrap = new WrapExecution({ kind: "wrap", argv: ["env", "-i", "PATH=/usr/bin:/bin", "bash", "-c", "{cmd}"] });
    expect(failed(await verifyRuntime(wrap, CAPABILITIES.wrap))).toEqual([]);
  });
});

describe("default runtime", () => {
  test("is microsandbox with msb and a hypervisor, otherwise local with a warning", () => {
    const probe = (msb: boolean, hv: boolean) => ({ which: () => msb, hypervisor: () => hv });
    expect(defaultRuntime(probe(true, true))).toEqual({ spec: DEFAULT_VM });
    expect(defaultRuntime(probe(true, false)).spec).toEqual({ kind: "local" });
    expect(defaultRuntime(probe(true, false)).warning).toContain("no hypervisor");
    expect(defaultRuntime(probe(false, true)).warning).toContain("msb is not installed");
    expect(Object.keys(runtimesFrom({}, {}, probe(true, true)))).toContain(DEFAULT_RUNTIME);
    expect(runtimeProblems({ default: { kind: "local" } })).toEqual(['runtimes.default: "default" is built in']);
  });
});

describe("health probe", () => {
  test("a live runtime answers, an unreachable one says why, a hung one times out", async () => {
    expect(await probeRuntime(new LocalExecution())).toMatchObject({ ok: true, detail: "answered" });
    const gone = new HttpSandboxExecution({ kind: "http", url: "http://127.0.0.1:9/exec" });
    const down = await probeRuntime(gone);
    expect(down.ok).toBe(false);
    expect(down.detail).toContain("unreachable");
    const hung: ExecutionPort = { run: () => new Promise(() => {}) };
    expect(await probeRuntime(hung, 50)).toMatchObject({ ok: false, detail: "no answer in 50 ms" });
  });
});
