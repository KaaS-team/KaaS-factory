// A stand-in for agent37's exec API (src/adapters/agent37): check the key,
// run `sh -c command` on this machine, answer {exit_code, stdout, stderr},
// and refuse a body over 128 KB the way the real one does. Tests start it
// on a free loopback port. `busyFirst` answers the first N requests 409
// try_again, as a sleeping instance does while it writes its checkpoint;
// `busyOn` does the same for the first `times` commands that start with `prefix`;
// `mainFails` answers every `bash -c` command with the given status, so a
// test can see whether the adapter sent it again. `maxWaitMs` answers 504 once a command has run
// that long while it keeps running, as the real exec does. `truncated` flags every answer cut off,
// `partDelayMs` slows part writes so their overlap shows in `peak()`, and `instance` may be a list.
// GET /v1/instances/<id> and /v1/billing answer the account calls, behind `Authorization: Bearer <key>`.

export interface Agent37Options {
  readonly busyFirst?: number;
  readonly busyOn?: { readonly prefix: string; readonly times: number };
  readonly maxWaitMs?: number;
  readonly truncated?: boolean;
  readonly partDelayMs?: number;
  readonly status?: string;
  readonly mainFails?: { readonly status: number; readonly code?: string };
}

export function startAgent37(
  key: string,
  instance: string | readonly string[],
  opts: Agent37Options = {},
): {
  url: string;
  stop: () => void;
  commands: string[];
  keys: Array<string | null>;
  bearers: Array<string | null>;
  instances: string[];
  peak: () => number;
} {
  const commands: string[] = [];
  const keys: Array<string | null> = [];
  const bearers: Array<string | null> = [];
  const instances: string[] = [];
  const ids = typeof instance === "string" ? [instance] : instance;
  let live = 0;
  let peak = 0;
  let busyLeft = opts.busyFirst ?? 0;
  let busyOnLeft = opts.busyOn?.times ?? 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      if (req.method === "GET") {
        bearers.push(req.headers.get("authorization"));
        if (req.headers.get("authorization") !== `Bearer ${key}`) return new Response("unauthorized", { status: 401 });
        if (path === "/v1/billing") return Response.json({ balance: 4.2 });
        if (ids.some((i) => path === `/v1/instances/${i}`)) return Response.json({ status: opts.status ?? "sleeping" });
        return new Response("no such route", { status: 404 });
      }
      keys.push(req.headers.get("x-agent37-key"));
      const hit = ids.find((i) => path === `/v1/instances/${i}/exec`);
      if (!hit) return new Response("no such instance", { status: 404 });
      instances.push(hit);
      if (req.headers.get("x-agent37-key") !== key) return new Response("unauthorized", { status: 401 });
      const body = await req.text();
      if (body.length > 128 * 1024) return new Response("The request body must be at most 128 KB.", { status: 413 });
      const { command } = JSON.parse(body) as { command: string };
      commands.push(command);
      if (busyLeft > 0) {
        busyLeft -= 1;
        return Response.json({ error: { code: "try_again" } }, { status: 409 });
      }
      if (opts.busyOn && busyOnLeft > 0 && command.startsWith(opts.busyOn.prefix)) {
        busyOnLeft -= 1;
        return Response.json({ error: { code: "try_again" } }, { status: 409 });
      }
      if (opts.mainFails && command.includes("bash -c")) {
        const { status, code } = opts.mainFails;
        return code ? Response.json({ error: { code } }, { status }) : new Response("gateway timeout", { status });
      }
      live += 1;
      peak = Math.max(peak, live);
      try {
        if (opts.partDelayMs && command.startsWith("printf %s ")) await Bun.sleep(opts.partDelayMs);
        const p = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" });
        const done = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        const cut = opts.maxWaitMs === undefined ? undefined : Bun.sleep(opts.maxWaitMs).then(() => "cut" as const);
        const got = await (cut ? Promise.race([done, cut]) : done);
        if (got === "cut") return new Response("gateway timeout", { status: 504 });
        const [stdout, stderr, exit_code] = got;
        return Response.json({ exit_code, stdout, stderr, truncated: opts.truncated === true });
      } finally {
        live -= 1;
      }
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true), commands, keys, bearers, instances, peak: () => peak };
}
