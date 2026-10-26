// The egress proxy: a guest reaches the network only through http://<proxy>/<host>/<path>, to hosts
// on an allow-list, and holds placeholders, never keys. The proxy swaps a placeholder for its real
// value only on a request to that secret's own hosts, the same rule msb applies inside a microVM.

import { SECRET } from "./adapters/microsandbox/execution";

export interface EgressSecret {
  readonly env: string;
  readonly value: string;
  readonly hosts: readonly string[];
}

export interface EgressOptions {
  readonly allow: readonly string[];
  // "ENV@host[,host]" entries, read from `env` on this machine.
  readonly secrets?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  // Tests point the upstream at a local server; production is always https.
  readonly upstream?: (host: string) => string;
  readonly hostname?: string;
}

export interface EgressProxy {
  readonly url: string;
  // What the guest's environment gets in place of each secret.
  readonly guestEnv: Readonly<Record<string, string>>;
  // Each refused request, for the run log: never the secret's value.
  readonly refused: readonly string[];
  stop(): void;
}

export function parseSecrets(
  entries: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): EgressSecret[] {
  return entries.map((entry) => {
    const m = SECRET.exec(entry);
    if (!m) throw new Error(`egress: "${entry}" is not ENV@host[,host]`);
    const value = env[m[1]!];
    if (!value) throw new Error(`egress: env var ${m[1]} is not set`);
    return { env: m[1]!, value, hosts: m[2]!.split(",") };
  });
}

export function startEgressProxy(opts: EgressOptions): EgressProxy {
  const secrets = parseSecrets(opts.secrets ?? [], opts.env ?? process.env);
  const allow = new Set([...opts.allow, ...secrets.flatMap((s) => s.hosts)]);
  const placeholders = new Map(secrets.map((s) => [`factory-egress-${s.env}-${crypto.randomUUID()}`, s]));
  const refused: string[] = [];
  const upstream = opts.upstream ?? ((host: string) => `https://${host}`);
  const deny = (why: string) => (refused.push(why), new Response(`egress: ${why}\n`, { status: 403 }));

  const server = Bun.serve({
    hostname: opts.hostname ?? "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const [, host = "", ...rest] = url.pathname.split("/");
      if (!allow.has(host)) return deny(`${host || "(no host)"} is not on the allow-list`);
      const headers = new Headers();
      for (const [k, raw] of req.headers) {
        if (k === "host" || k === "content-length") continue;
        let v = raw;
        for (const [token, s] of placeholders) {
          if (!v.includes(token)) continue;
          if (!s.hosts.includes(host)) return deny(`${s.env} may not go to ${host}`);
          v = v.replaceAll(token, s.value);
        }
        headers.set(k, v);
      }
      const body = req.body ? await req.arrayBuffer() : undefined;
      // A placeholder in a body is never swapped: keys travel in headers, and a body could be a leak.
      if (body && [...placeholders.keys()].some((t) => new TextDecoder().decode(body).includes(t)))
        return deny(`a request body to ${host} carries a secret placeholder`);
      return fetch(`${upstream(host)}/${rest.join("/")}${url.search}`, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(600_000)]),
      });
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    guestEnv: Object.fromEntries([...placeholders].map(([token, s]) => [s.env, token])),
    refused,
    stop: () => server.stop(true),
  };
}
