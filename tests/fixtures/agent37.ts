// A stand-in for agent37's exec API (src/adapters/agent37): check the key,
// run `sh -c command` on this machine, answer {exit_code, stdout, stderr},
// and refuse a body over 128 KB the way the real one does. Tests start it
// on a free loopback port. `busyFirst` answers the first N requests 409
// try_again, as a sleeping instance does while it writes its checkpoint;
// `mainFails` answers every `bash -c` command with the given status, so a
// test can see whether the adapter sent it again.

export interface Agent37Options {
  readonly busyFirst?: number;
  readonly mainFails?: { readonly status: number; readonly code?: string };
}

export function startAgent37(
  key: string,
  instance: string,
  opts: Agent37Options = {},
): { url: string; stop: () => void; commands: string[]; keys: Array<string | null> } {
  const commands: string[] = [];
  const keys: Array<string | null> = [];
  let busyLeft = opts.busyFirst ?? 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      keys.push(req.headers.get("x-agent37-key"));
      if (new URL(req.url).pathname !== `/v1/instances/${instance}/exec`) return new Response("no such instance", { status: 404 });
      if (req.headers.get("x-agent37-key") !== key) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      if (body.length > 128 * 1024) return new Response("The request body must be at most 128 KB.", { status: 413 });
      const { command } = JSON.parse(body) as { command: string };
      commands.push(command);
      if (busyLeft > 0) {
        busyLeft -= 1;
        return Response.json({ error: { code: "try_again" } }, { status: 409 });
      }
      if (opts.mainFails && command.includes("bash -c")) {
        const { status, code } = opts.mainFails;
        return code ? Response.json({ error: { code } }, { status }) : new Response("gateway timeout", { status });
      }
      const p = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, exit_code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
      return Response.json({ exit_code, stdout, stderr, truncated: false });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), commands, keys };
}
