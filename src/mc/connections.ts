// Mission control connections live in machine.json under sessions.connections. A connection names the
// environment variable that holds its key, never the key, and the config hash sees only that name.

export interface Connection {
  kind: string;
  tokenEnv?: string;
  webhookSecretEnv?: string;
  url?: string;
  allowPrivate?: boolean;
  repos?: string[];
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const SECRET_KEY = /token|key|secret|password/i;
const LOOPBACK = /^(localhost|127(\.\d+){3}|\[::1\])$/;

export function connectionProblems(raw: unknown): string[] {
  if (raw === undefined) return [];
  const out: string[] = [];
  const conns = (raw as { connections?: unknown } | null)?.connections;
  if (!raw || typeof raw !== "object" || !conns || typeof conns !== "object" || Array.isArray(conns))
    return ['"sessions" must be { "connections": { <name>: { "kind": ... } } }'];
  for (const [name, c] of Object.entries(conns)) {
    const at = `sessions.connections "${name}"`;
    if (!NAME.test(name)) out.push(`${at}: the name must match ${NAME.source}`);
    if (!c || typeof c !== "object" || Array.isArray(c)) {
      out.push(`${at}: must be an object`);
      continue;
    }
    const conn = c as Record<string, unknown>;
    if (typeof conn.kind !== "string" || !conn.kind) out.push(`${at}: "kind" must be a non-empty string`);
    for (const [k, v] of Object.entries(conn)) {
      if (k.endsWith("Env")) {
        if (typeof v !== "string" || !ENV_NAME.test(v))
          out.push(`${at}: "${k}" must be an environment variable name matching ${ENV_NAME.source}`);
      } else if (SECRET_KEY.test(k)) {
        out.push(`${at}: "${k}" holds a value: name the environment variable ("${k}Env"), never the value`);
      }
    }
    if (conn.url !== undefined) {
      let ok = false;
      try {
        const u = new URL(String(conn.url));
        ok =
          u.protocol === "https:" ||
          (u.protocol === "http:" && conn.allowPrivate === true && LOOPBACK.test(u.hostname));
      } catch {}
      if (!ok) out.push(`${at}: "url" must be https (or loopback http with "allowPrivate")`);
    }
  }
  return out;
}

export function connectionHashInput(connections: Readonly<Record<string, Connection>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, c] of Object.entries(connections))
    out[name] = {
      kind: c.kind,
      url: c.url,
      tokenEnv: c.tokenEnv,
      webhookSecretEnv: c.webhookSecretEnv,
      repos: c.repos,
    };
  return out;
}
