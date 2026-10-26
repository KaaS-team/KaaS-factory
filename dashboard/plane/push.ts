// Push to paired phones for two moments only: something needs you, or a run is done. The tick reads
// the plane's own inbox and runs, so a push never says more than the screen would; the first tick
// only learns what is already there, and nobody is pushed while they have the cockpit open.
import type { NotifierPort, Notice } from "../../src/ports/notifier";
import type { PushOwner, PushSubscription } from "../../src/adapters/webpush/notifier";
import type { Route } from "./access";

export const PRESENCE_MS = 45_000;
type Handle = (req: Request) => Promise<Response>;

export interface PushPlane {
  notifier: NotifierPort;
  publicKey: () => Promise<string>;
  subscribe: (sub: PushSubscription, owner: PushOwner) => Promise<boolean>;
  unsubscribe: (endpoint: string, login: string) => Promise<boolean>;
  // The caller as a subscription owner, or null for a caller that is not a member.
  ownerOf: (req: Request) => PushOwner | null;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export function pushTicker(handle: Handle, push: PushPlane, now = Date.now) {
  let seen: Set<string> | undefined;
  const seenAt = new Map<string, number>();
  // Presence is per person: one member watching never silences another member's phone.
  const present = (login: string) => now() - (seenAt.get(login) ?? -Infinity) < PRESENCE_MS;
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
        const owner = push.ownerOf(req);
        if (!owner) return json({ error: "notifications are for members" }, 403);
        return (await push.subscribe(sub, owner).catch(() => false))
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
        const login = push.ownerOf(req)?.login;
        if (typeof endpoint !== "string" || !login || !(await push.unsubscribe(endpoint, login)))
          return json({ error: "no such subscription of yours" }, 404);
        return json({ ok: true });
      },
    },
    {
      method: "POST",
      pattern: /^\/api\/presence$/,
      label: "POST /api/presence",
      role: "viewer",
      handler: (req) => {
        const login = push.ownerOf(req)?.login;
        if (login) seenAt.set(login, now());
        return json({ ok: true });
      },
    },
  ];
  return { tick, routes, present };
}
