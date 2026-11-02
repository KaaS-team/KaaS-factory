// Preview health is the factory's own check: two answers in a row, at the head sha. A provider's
// GitHub deployment record says where the preview lives, so the factory can look before it asks.

export interface DeploymentStatus {
  readonly state: string;
  readonly environmentUrl?: string;
  readonly logUrl?: string;
  readonly createdAt: string;
}

export interface Deployment {
  readonly sha: string;
  readonly environment: string;
  readonly statuses: readonly DeploymentStatus[];
}

export interface PickedDeployment {
  readonly environmentUrl?: string;
  readonly logUrl?: string;
}

// Statuses are copied by the caller, not linked, because GitHub deletes old ones.
export function pickDeployment(
  deployments: readonly Deployment[],
  { head, environment }: { head: string; environment: string },
): PickedDeployment | undefined {
  let best: DeploymentStatus | undefined;
  for (const d of deployments.filter((d) => d.sha === head && d.environment.startsWith(environment))) {
    const newest = [...d.statuses]
      .filter((s) => s.state === "success" || s.state === "inactive")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (newest?.state !== "success") continue;
    if (!best || Date.parse(newest.createdAt) > Date.parse(best.createdAt)) best = newest;
  }
  return best && { environmentUrl: best.environmentUrl, logUrl: best.logUrl };
}

export interface HealthOptions {
  readonly path: string;
  // "none", "header:<name>" or "body:sha" (a top-level JSON `sha`).
  readonly expectSha: string;
  readonly head: string;
  readonly fetch?: typeof fetch;
  readonly attempts?: number;
}

export async function checkHealth(url: string, o: HealthOptions): Promise<{ healthy: boolean; sha?: string }> {
  const doFetch = o.fetch ?? fetch;
  const attempts = o.attempts ?? 2;
  let sha: string | undefined;
  for (let i = 0; i < attempts; i++) {
    let ok = false;
    try {
      const res = await doFetch(url + o.path, { signal: AbortSignal.timeout(10_000), redirect: "follow" });
      ok = res.status >= 200 && res.status < 300;
      if (ok && o.expectSha.startsWith("header:")) sha = res.headers.get(o.expectSha.slice(7)) ?? undefined;
      else if (ok && o.expectSha === "body:sha") {
        const body: unknown = await res.json().catch(() => undefined);
        const v = typeof body === "object" && body !== null ? (body as { sha?: unknown }).sha : undefined;
        sha = typeof v === "string" ? v : undefined;
      }
    } catch {
      ok = false;
    }
    if (!ok) return { healthy: false, sha };
    if (o.expectSha !== "none" && sha !== o.head) return { healthy: false, sha };
  }
  return { healthy: true, sha };
}

export function teardownDue(o: {
  prState: "open" | "closed" | "merged";
  ttlExpired: boolean;
  tornDown: boolean;
}): boolean {
  if (o.tornDown) return false;
  return o.prState !== "open" || o.ttlExpired;
}
