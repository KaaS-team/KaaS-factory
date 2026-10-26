// The runner's half of the dial-out protocol (dashboard/plane/runner-routes.ts is the other). The
// runner only ever connects out: it follows its event stream and posts answers, so it can sit
// behind NAT with no open port. A dropped stream resumes from the last event it handled.
import type { EventSourcePort, SourceEvent } from "./ports/event-source";

export interface RunnerCreds {
  readonly url: string;
  readonly id: string;
  readonly secret: string;
}

export type StopKind = "cancel" | "takeover";
export interface RunnerJob {
  readonly repo: string;
  readonly issue: number;
}

// What the runner does with what the plane sends; the CLI wires these to `factory run`.
export interface RunnerWork {
  run(job: RunnerJob): Promise<void>;
  deliver(job: RunnerJob, text: string): Promise<void>;
  stop(job: RunnerJob, kind: StopKind): Promise<void>;
}

export interface DialOptions {
  readonly source: EventSourcePort;
  // The repos this runner holds a checkout of; the plane leases it work in these only.
  readonly repos: readonly string[];
  readonly fetch?: typeof fetch;
  readonly heartbeatMs?: number;
  readonly retryMs?: number;
  readonly signal?: AbortSignal;
  // The last event handled before a restart, so a new process resumes instead of replaying.
  readonly after?: number;
}

// The token is spent by this call; the secret it returns is the runner's only credential.
export async function registerRunner(
  url: string,
  token: string,
  name: string,
  doFetch: typeof fetch = fetch,
): Promise<RunnerCreds> {
  const base = url.replace(/\/+$/, "");
  const res = await doFetch(`${base}/runner/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, name }),
  });
  const body = (await res.json().catch(() => ({}))) as { id?: string; secret?: string; error?: string };
  if (!res.ok || !body.id || !body.secret)
    throw new Error(body.error ?? `the plane refused the runner: HTTP ${res.status}`);
  return { url: base, id: body.id, secret: body.secret };
}

export function dialOut(creds: RunnerCreds, work: RunnerWork, opts: DialOptions) {
  const doFetch = opts.fetch ?? fetch;
  const post = async (event: Record<string, unknown>) => {
    const res = await doFetch(`${creds.url}/runner/events`, {
      method: "POST",
      keepalive: false,
      headers: { authorization: `Bearer ${creds.secret}`, "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    return res.ok;
  };
  let last = opts.after ?? 0;

  async function onEvent(e: SourceEvent): Promise<void> {
    const d = e.data as { repo: string; issue: number; id?: number; text?: string };
    last = e.seq;
    // The plane leases only declared repos; a job for another one would run in the wrong checkout.
    if (!opts.repos.includes(d.repo)) return;
    const job = { repo: d.repo, issue: d.issue };
    if (e.type === "lease")
      void work
        .run(job)
        .then(() => post({ type: "done", ...job }))
        .catch(() => {});
    // Read before delivering: the plane refuses a message that was undone in the meantime.
    else if (e.type === "message" && (await post({ type: "read", id: d.id }).catch(() => false)))
      await work.deliver(job, d.text ?? "");
    else if (e.type === "cancel" || e.type === "takeover") await work.stop(job, e.type);
  }

  const beat = () => void post({ type: "heartbeat", repos: opts.repos }).catch(() => false);
  beat();
  const timer = setInterval(beat, opts.heartbeatMs ?? 15_000);

  const done = (async () => {
    while (!opts.signal?.aborted) {
      try {
        last = await opts.source.follow(last, onEvent, opts.signal);
      } catch {
        if (opts.signal?.aborted) break;
      }
      await Bun.sleep(opts.retryMs ?? 2000);
    }
    clearInterval(timer);
  })();
  return { done, lastSeq: () => last, heartbeat: () => post({ type: "heartbeat", repos: opts.repos }) };
}
