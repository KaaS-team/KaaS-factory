// The checks every SessionAdapter passes, whoever wrote it (the session twin of src/runtime-kit.ts).

import type { KitCheck } from "../runtime-kit";
import { type SessionAdapter, type SessionRef, SessionUnsupported } from "../ports/session";
import { schemaProblem, SESSION_SCHEMA } from "./schema";

const unsupported = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof SessionUnsupported;
  }
};

function after<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} took more than ${ms} ms`)), ms)),
  ]);
}

export async function adapterKit(adapter: SessionAdapter, probe: { ref?: SessionRef } = {}): Promise<KitCheck[]> {
  const checks: KitCheck[] = [];
  const check = async (name: string, body: () => Promise<string | undefined>) => {
    try {
      const problem = await body();
      checks.push(problem ? { name, ok: false, detail: problem } : { name, ok: true });
    } catch (err) {
      checks.push({ name, ok: false, detail: err instanceof Error ? err.message : String(err) });
    }
  };
  const ref: SessionRef = probe.ref ?? { runtime: adapter.kind, connection: "kit", externalId: "kit-probe" };
  let rows: Awaited<ReturnType<SessionAdapter["list"]>> = [];

  await check("list answers within 10 s and every row fits the schema", async () => {
    if (!adapter.caps.list) return undefined;
    rows = await after(adapter.list(), 10_000, "list");
    for (const r of rows) {
      const p = schemaProblem(SESSION_SCHEMA, r);
      if (p) return p;
    }
    return undefined;
  });
  await check("every ref.runtime equals the adapter kind", async () => {
    const bad = rows.find((r) => r.ref.runtime !== adapter.kind);
    return bad ? `${bad.ref.externalId} has runtime ${bad.ref.runtime}, want ${adapter.kind}` : undefined;
  });
  await check("a link is https: or absent", async () => {
    const urls = [adapter.link(ref), ...rows.map((r) => r.link ?? adapter.link(r.ref))];
    const bad = urls.find((u) => u !== undefined && !u.startsWith("https:"));
    return bad ? `link ${bad} is not https:` : undefined;
  });
  const verbs: [string, boolean, () => Promise<unknown>][] = [
    ["list", adapter.caps.list, () => adapter.list()],
    ["cancel", adapter.caps.cancel, () => adapter.cancel(ref)],
    ["followUp", adapter.caps.followUp, () => adapter.followUp(ref, "kit probe")],
  ];
  for (const [verb, flag, call] of verbs) {
    await check(`${verb}: flag ${flag} matches behaviour`, async () => {
      const threw = await unsupported(call);
      if (!flag && !threw) return `${verb} is false but did not throw SessionUnsupported`;
      if (flag && threw) return `${verb} is true but threw SessionUnsupported`;
      return undefined;
    });
  }
  await check("follow with an aborted signal resolves within 1 s", async () => {
    if (adapter.caps.events === "none") return undefined;
    const ctl = new AbortController();
    ctl.abort();
    await after(
      adapter.follow(ref, undefined, () => {}, ctl.signal),
      1_000,
      "follow",
    );
    return undefined;
  });
  return checks;
}
