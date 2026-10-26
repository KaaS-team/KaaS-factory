// Every runtime kind's capability flags, and the sandbox contract on top of any ExecutionPort.
// Each adapter already runs a command in a host directory it mounts or ships, so that directory
// is the sandbox's file system here: files, snapshot and restore work the same on every runtime.

import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { ExecutionPort } from "./ports/execution";
import {
  type Sandbox,
  type SandboxCapabilities,
  type SandboxCreate,
  type SandboxProvider,
  type SandboxStatus,
  SandboxUnsupported,
} from "./ports/sandbox";
import type { RuntimeSpec } from "./runtimes";

const caps = (
  isolation: SandboxCapabilities["isolation"],
  egress: SandboxCapabilities["egress"],
  byo = false,
): SandboxCapabilities => ({ isolation, byo, snapshot: true, memoryResume: false, expose: false, egress });

// "deny" only where the adapter itself turns the network off by default (docker `--network none`,
// msb `--no-net`); a wrap launcher, a pool or a vendor decides for itself.
export const CAPABILITIES: Readonly<Record<RuntimeSpec["kind"], SandboxCapabilities>> = {
  local: caps("none", "open"),
  docker: caps("container", "deny"),
  ssh: caps("remote", "open", true),
  lwpr: caps("remote", "open", true),
  wrap: caps("unknown", "provider", true),
  http: caps("remote", "provider", true),
  agent37: caps("remote", "provider", true),
  microsandbox: caps("microvm", "deny"),
  codespaces: caps("remote", "open", true),
  pool: caps("unknown", "provider", true),
};

export function capabilitiesOf(spec: RuntimeSpec): SandboxCapabilities {
  // A docker runtime that names a network has one.
  if (spec.kind === "docker" && spec.network && spec.network !== "none")
    return { ...CAPABILITIES.docker, egress: "open" };
  return CAPABILITIES[spec.kind];
}

class WorkdirSandbox implements Sandbox {
  private state: SandboxStatus = "running";
  constructor(
    readonly id: string,
    private readonly dir: string,
    private readonly port: ExecutionPort,
    private readonly snapshots: string,
    private readonly env: Readonly<Record<string, string>>,
  ) {}

  private inside(path: string): string {
    const full = resolve(this.dir, path);
    if (relative(this.dir, full).startsWith("..")) throw new Error(`sandbox: ${path} is outside the sandbox`);
    return full;
  }
  private live(): void {
    if (this.state !== "running") throw new Error(`sandbox ${this.id} is ${this.state}`);
  }

  async exec(cmd: string, signal?: AbortSignal) {
    this.live();
    const exports = Object.entries(this.env).map(([k, v]) => `export ${k}='${v.replaceAll("'", "'\\''")}'; `);
    return this.port.run(`${exports.join("")}${cmd}`, this.dir, signal);
  }
  readonly files = {
    put: async (path: string, data: string | Uint8Array) => {
      this.live();
      const full = this.inside(path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, data);
    },
    get: async (path: string) => new Uint8Array(readFileSync(this.inside(path))),
    list: async (dir = ".") => readdirSync(this.inside(dir), { recursive: true }).map(String).sort(),
  };
  async snapshot() {
    const id = `snap-${crypto.randomUUID()}`;
    cpSync(this.dir, join(this.snapshots, id), { recursive: true });
    return id;
  }
  async pause() {
    this.live();
    this.state = "paused";
    return { memoryKept: false };
  }
  async resume() {
    if (this.state === "paused") this.state = "running";
  }
  async expose(port: number): Promise<string> {
    throw new SandboxUnsupported(`sandbox ${this.id}: this runtime cannot expose port ${port}`);
  }
  async status() {
    return this.state;
  }
  async destroy() {
    rmSync(this.dir, { recursive: true, force: true });
    this.state = "destroyed";
  }
}

// One provider per runtime: snapshots live under `root`, so a restore works across sandboxes.
export function sandboxProvider(
  port: ExecutionPort,
  capabilities: SandboxCapabilities,
  root = mkdtempSync(join(tmpdir(), "factory-sandboxes-")),
): SandboxProvider {
  const snapshots = join(root, "snapshots");
  mkdirSync(snapshots, { recursive: true });
  return {
    capabilities,
    async create(opts: SandboxCreate = {}) {
      const bad = Object.keys(opts.env ?? {}).find((k) => !/^[A-Za-z_]\w*$/.test(k));
      if (bad) throw new Error(`sandbox: ${JSON.stringify(bad)} is not an env var name`);
      const id = `sbx-${crypto.randomUUID()}`;
      const dir = join(root, id);
      if (opts.snapshot) {
        if (!/^snap-[\w-]+$/.test(opts.snapshot)) throw new Error(`sandbox: no snapshot ${opts.snapshot}`);
        cpSync(join(snapshots, opts.snapshot), dir, { recursive: true });
      } else mkdirSync(dir);
      return new WorkdirSandbox(id, dir, port, snapshots, opts.env ?? {});
    },
  };
}
