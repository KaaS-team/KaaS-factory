import type { Actor } from "./access";
import { atLeast } from "./store";

// Operator detail: what a run cost, which model ran it, which machine. A viewer's JSON never carries
// it, so a route that forgets to drop a field still cannot show it to a customer.
export const OPERATOR_KEYS: ReadonlySet<string> = new Set([
  "model",
  "models",
  "byModel",
  "cost",
  "cost_usd",
  "costUsd",
  "totalUsd",
  "dailyUsd",
  "spend7dUsd",
  "spend30dUsd",
  "savings",
  "token_usage",
  "tokens_in",
  "tokens_out",
  "tokens_cached",
  "worker_name",
  "host",
  "hostname",
  "machine",
]);

export function withoutOperatorDetail(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutOperatorDetail);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !OPERATOR_KEYS.has(k))
      .map(([k, v]) => [k, withoutOperatorDetail(v)]),
  );
}

export async function withheld(who: Actor | undefined, res: Response): Promise<Response> {
  if (!who || atLeast(who.role, "operator")) return res;
  if (!(res.headers.get("content-type") ?? "").startsWith("application/json")) return res;
  const body = withoutOperatorDetail(await res.json());
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(body), { status: res.status, headers });
}
