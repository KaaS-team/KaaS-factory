// Publishes the inbox and the week to a kaas-relay (relay/), so the installed cockpit on a phone
// can follow it when the dashboard is out of reach. It reads through the dashboard's own routes,
// so the relay sees exactly what the inbox shows, and sends only when that changes.

type Handle = (req: Request, remoteAddress?: string) => Promise<Response>;

export interface RelayTarget {
  readonly url: string;
  readonly token: string;
  readonly channel: string;
}

// The relay refuses a line over 64 KiB; these caps keep a busy inbox well under it.
const MAX_ITEMS = 50;
const MAX_ASK = 280;

export function relayTarget(env: Record<string, string | undefined>): RelayTarget | undefined {
  const url = env.FACTORY_RELAY_URL?.replace(/\/+$/, "");
  const token = env.FACTORY_RELAY_TOKEN;
  if (!url || !token) return undefined;
  return { url, token, channel: env.FACTORY_RELAY_CHANNEL || "inbox" };
}

export function relayPublisher(handle: Handle, target: RelayTarget, send: typeof fetch = fetch) {
  let last = "";
  const read = async (path: string) => {
    const res = await handle(new Request(`http://127.0.0.1${path}`), "127.0.0.1");
    return res.ok ? ((await res.json()) as Record<string, unknown>) : undefined;
  };
  // Resolves to whether it sent; a failed read or send waits for the next tick, never throws.
  return async function tick(): Promise<boolean> {
    try {
      const [inbox, analytics] = await Promise.all([read("/api/inbox"), read("/api/analytics")]);
      if (!inbox) return false;
      const items = ((inbox.items ?? []) as Record<string, unknown>[]).slice(0, MAX_ITEMS).map((i) => ({
        repo: i.repo,
        issue: i.issue,
        title: i.title,
        kind: i.kind,
        waitingSince: i.waitingSince,
        ask: String(i.ask ?? "").slice(0, MAX_ASK),
      }));
      const body = JSON.stringify({
        items,
        analytics: analytics && { week: analytics.week, spend7dUsd: analytics.spend7dUsd },
      });
      if (body === last) return false;
      const res = await send(`${target.url}/publish/${target.channel}`, {
        method: "POST",
        headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
        body,
      });
      if (!res.ok) return false;
      last = body;
      return true;
    } catch {
      return false;
    }
  };
}

export function startRelay(handle: Handle, env = process.env, everyMs = 10_000): void {
  const target = relayTarget(env);
  if (!target) return;
  const tick = relayPublisher(handle, target);
  void tick();
  setInterval(tick, everyMs);
  console.log(`factory dashboard: publishing the inbox to ${target.url} (channel ${target.channel})`);
}
