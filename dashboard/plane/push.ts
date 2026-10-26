// Push to paired phones for two moments only: something needs you, or a run is done. The tick reads
// the plane's own inbox and runs, so a push never says more than the screen would; the first tick
// only learns what is already there, and nothing is pushed while someone has the cockpit open.
import type { NotifierPort, Notice } from "../../src/ports/notifier";
import type { PushSubscription } from "../../src/adapters/webpush/notifier";
import type { Route } from "./access";

export const PRESENCE_MS = 45_000;
type Handle = (req: Request) => Promise<Response>;

export interface PushPlane {
  notifier: NotifierPort;
  publicKey: () => Promise<string>;
  subscribe: (sub: PushSubscription) => Promise<boolean>;
  unsubscribe: (endpoint: string) => Promise<void>;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function pushTicker(handle: Handle, push: PushPlane, now = Date.now) {
  let seen: Set<string> | undefined;
  let present = 0;
  const read = async (path: string) => {
    const res = await handle(new Request(`http://127.0.0.1${path}`));
    return res.ok ? ((await res.json()) as Record<string, unknown>) : {};
  };
  async function tick(): Promise<Notice[]> {
    const [inbox, runs] = await Promise.all([read("/api/inbox"), read("/api/runs")]);
    const notices: [string, Notice][] = [];
    for (const i of (inbox.items ?? []) as Record<string, unknown>[])
      notices.push([
        `in:${i.repo}#${i.issue}:${i.kind}`,
        { kind: "needs-you", title: `#${i.issue} needs you`, body: String(i.title ?? ""), url: `/#issue=${i.issue}` },
      ]);
    for (const r of (runs.runs ?? []) as Record<string, unknown>[])
      if (r.status === "shipped")
        notices.push([
          `done:${r.id}`,
          { kind: "done", title: `#${r.issue} is done`, body: String(r.title ?? ""), url: `/#issue=${r.issue}` },
        ]);
    const fresh = seen ? notices.filter(([id]) => !seen!.has(id)).map(([, n]) => n) : [];
    seen = new Set(notices.map(([id]) => id));
    if (now() - present < PRESENCE_MS) return [];
    for (const n of fresh) await push.notifier.notify(n);
    return fresh;
  }
  const routes: Route[] = [
    {
      method: "GET",
      pattern: /^\/api\/push\/key$/,
      label: "GET /api/push/key",
      role: "viewer",
      handler: async () => json({ key: await push.publicKey() }),
    },
    {
      method: "POST",
      pattern: /^\/api\/push\/subscribe$/,
      label: "POST /api/push/subscribe",
      role: "viewer",
      handler: async (req) => {
        const sub = (await req.json().catch(() => ({}))) as PushSubscription;
        return (await push.subscribe(sub).catch(() => false))
          ? json({ ok: true })
          : json({ error: "not a push subscription this plane accepts" }, 400);
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/push\/unsubscribe$/,
      label: "POST /api/push/unsubscribe",
      role: "viewer",
      handler: async (req) => {
        const { endpoint } = (await req.json().catch(() => ({}))) as { endpoint?: unknown };
        if (typeof endpoint === "string") await push.unsubscribe(endpoint);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/presence$/,
      label: "POST /api/presence",
      role: "viewer",
      handler: () => {
        present = now();
        return json({ ok: true });
      },
    },
  ];
  return { tick, routes };
}
