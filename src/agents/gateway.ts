// A LiteLLM gateway (machine.json `llmGateway`) gives each stage run its own key, capped at the
// stage's maxBudgetUsd by the gateway itself. The agent never sees the master key or a provider
// key, so a runaway stage stops at its cap whatever the CLI reports about its own cost.

export interface LlmGateway {
  readonly url: string;
  readonly masterKey: string;
}

// The env var the master key is read from. FACTORY_* is stripped from every agent's env.
export const GATEWAY_KEY_ENV = "FACTORY_LLM_GATEWAY_KEY";

// Model APIs an agent could call around the gateway, matched by domain suffix. A known list, not a
// proof: the VM's own deny-by-default egress is what keeps an unlisted provider out.
export const PROVIDER_DOMAINS = [
  "anthropic.com",
  "openai.com",
  "chatgpt.com",
  "openrouter.ai",
  "googleapis.com",
  "mistral.ai",
  "groq.com",
  "x.ai",
  "deepseek.com",
  "cursor.sh",
  "cursor.com",
  "amazonaws.com",
  "azure.com",
] as const;

// Case and a trailing dot name the same host to DNS, so they must not slip past the match.
export function isProviderHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return PROVIDER_DOMAINS.some((d) => h === d || h.endsWith(`.${d}`));
}

export function gatewayHost(gateway: { url: string }): string {
  return new URL(gateway.url).hostname;
}

async function call(gateway: LlmGateway, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${gateway.url.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${gateway.masterKey}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`llmGateway: ${path} answered HTTP ${res.status}`);
  return res.json();
}

// The key outlives the stage by a few minutes only, so a key the revoke missed expires on its own.
export async function mintStageKey(
  gateway: LlmGateway,
  run: { maxBudgetUsd: number; timeoutMinutes: number; issue: number; stage: string },
): Promise<string> {
  const reply = (await call(gateway, "/key/generate", {
    max_budget: run.maxBudgetUsd,
    duration: `${Math.ceil(run.timeoutMinutes) + 5}m`,
    metadata: { issue: run.issue, stage: run.stage },
  })) as { key?: unknown };
  if (typeof reply.key !== "string" || !reply.key) throw new Error("llmGateway: /key/generate returned no key");
  return reply.key;
}

// Best effort: a failed revoke leaves a key that is capped and expires minutes later.
export async function revokeKey(gateway: LlmGateway, key: string): Promise<void> {
  await call(gateway, "/key/delete", { keys: [key] }).catch(() => {});
}
