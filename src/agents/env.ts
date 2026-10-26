// Ported from owainlewis/machinist@3943516 internal/runner/runner.go:669-706 (MIT, Copyright (c) 2026 Owain Lewis). Deviations: also strips GH_TOKEN, GITHUB_TOKEN and FACTORY_* (the runner's own secrets, audit finding #14), which machinist has no equivalent of.

// The agent inherits everything else (PATH, HOME, its own model key): it needs
// a key to work, so the residual risk is a spend-capped key, documented in the README.
const STRIPPED_ENV_PREFIXES = ["GH_TOKEN", "GITHUB_TOKEN", "FACTORY_", "GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_"];

// Repository-pointing git variables. A leaked GIT_DIR or GIT_INDEX_FILE makes
// the agent's git commands act on the wrong repository.
const REPOSITORY_GIT_ENV = new Set([
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_INTERNAL_SUPER_PREFIX",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
]);

// Every provider key the presets know. An agent keeps only its own `envKeys`, so a
// Codex stage never sees the Anthropic key. Agents with no preset keep them all.
export const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "CURSOR_API_KEY",
  "OPENROUTER_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
] as const;

// Other ways a CLI reaches a model on its own credentials. Through a gateway none of them may remain.
const GATEWAY_STRIPPED = [
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CODEX_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_PROJECT",
  "HF_TOKEN",
  "COPILOT_GITHUB_TOKEN",
];
const GATEWAY_STRIPPED_PREFIXES = [
  "AWS_",
  "AZURE_",
  "CLOUDSDK_",
  "ANTHROPIC_BEDROCK_",
  "ANTHROPIC_VERTEX_",
  "ANTHROPIC_FOUNDRY_",
];

// One predicate for both places a gateway run drops credentials: the env and the VM's secrets.
export function isProviderCredential(key: string): boolean {
  return (
    (PROVIDER_KEYS as readonly string[]).includes(key) ||
    GATEWAY_STRIPPED.includes(key) ||
    GATEWAY_STRIPPED_PREFIXES.some((p) => key.startsWith(p))
  );
}

// Every env var a config names as a `tokenEnv` (tracker, runtimes, pool members): the runner's
// keys, which no agent may read. Walked, not listed, so a new adapter's key is dropped too.
export function tokenEnvNames(...configs: unknown[]): string[] {
  const names = new Set<string>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (k === "tokenEnv" && typeof x === "string") names.add(x);
        else walk(x);
      }
  };
  configs.forEach(walk);
  return [...names];
}

// The env of an agent that calls through a gateway: no provider key or credential of any kind.
export function gatewaySanitizedEnv(env: NodeJS.ProcessEnv, drop: readonly string[] = []): Record<string, string> {
  const out = sanitizeEnv(env, [], drop);
  for (const key of Object.keys(out)) if (isProviderCredential(key)) delete out[key];
  return out;
}

export function sanitizeEnv(
  env: NodeJS.ProcessEnv,
  keep?: readonly string[],
  drop: readonly string[] = [],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || drop.includes(key)) continue;
    if (keep && (PROVIDER_KEYS as readonly string[]).includes(key) && !keep.includes(key)) continue;
    if (REPOSITORY_GIT_ENV.has(key) || STRIPPED_ENV_PREFIXES.some((p) => key === p || key.startsWith(p))) continue;
    out[key] = value;
  }
  return out;
}
