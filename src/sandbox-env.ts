// The exact setting names the runner forwards into an agent sandbox (a VM or container guest).
// In a VM the guest gets only these (msb injects provider keys from its own env).
// Nothing is forwarded by prefix: a platform-injected or stray FACTORY_* value never crosses, and
// a real secret never shares a forwarded name. Per-stage model and effort are CLI flags
// (CLAUDE_STAGE_DEFAULTS), not env, so no model or effort pattern is listed until a reader exists.
// tests/sandbox-env.test.ts ties this list to what the sandbox reads.

// Read by the template hooks and .factory/qa.sh inside the sandbox.
export const SANDBOX_SETTINGS = [
  "FACTORY_ARTIFACT_DIR",
  "FACTORY_HIDDEN_PATHS",
  "FACTORY_ISSUE",
  "FACTORY_SCRATCH_DIR",
  "FACTORY_STAGE",
  // Read by the agent CLI itself; set by its preset.
  "CLAUDE_CODE_DISABLE_BACKGROUND_TASKS",
  "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
] as const;

const CREDENTIAL_WORD = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|AUTH)S?$/i;
const PLACEHOLDER = /^(|placeholder|dummy|redacted|changeme|x{3,}|\*{3,}|<[^>]*>)$/i;

export const looksLikeCredential = (name: string): boolean => CREDENTIAL_WORD.test(name);
export const isPlaceholder = (value: string): boolean => PLACEHOLDER.test(value);

// Keep only the enumerated names. A credential-shaped name must carry a placeholder, never a real value.
export function forwardSettings(
  env: Readonly<Record<string, string>>,
  names: readonly string[] = SANDBOX_SETTINGS,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value === undefined) continue;
    if (looksLikeCredential(name) && !isPlaceholder(value))
      throw new Error(`sandbox: ${name} looks like a credential and its value is not a placeholder`);
    out[name] = value;
  }
  return out;
}
