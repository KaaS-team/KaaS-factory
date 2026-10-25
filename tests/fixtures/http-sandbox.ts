// A reference server for the http runtime's protocol (src/adapters/http-sandbox):
// unpack the archive in a fresh directory, run `bash -c cmd` there, answer
// {stdout, stderr, code}. A shim in front of a hosted sandbox does the same
// inside the sandbox. Tests start it on a free loopback port.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function startSandbox(token: string): { url: string; stop: () => void; requests: Array<{ auth: string | null }> } {
  const requests: Array<{ auth: string | null }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      requests.push({ auth: req.headers.get("authorization") });
      if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized", { status: 401 });
      const { cmd, archive } = (await req.json()) as { cmd: string; archive: string };
      const dir = mkdtempSync(join(tmpdir(), "factory-sandbox-"));
      try {
        writeFileSync(join(dir, ".in.tgz"), Buffer.from(archive, "base64"));
        Bun.spawnSync(["tar", "-xzf", ".in.tgz"], { cwd: dir });
        rmSync(join(dir, ".in.tgz"));
        const p = Bun.spawn(["bash", "-c", cmd], { cwd: dir, stdout: "pipe", stderr: "pipe" });
        const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        return Response.json({ stdout, stderr, code });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}/exec`, stop: () => server.stop(true), requests };
}
