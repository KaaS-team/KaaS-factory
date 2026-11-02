import type { ProviderSpec } from "../orchestrate/config";
import type { SecretsPort } from "../ports/secrets";
import { claudeCloudProvider } from "./claude";
import { cursorProvider } from "./cursor";
import type { CloudProvider } from "./port";

export function cloudProvider(
  name: string,
  orch: { providers: Record<string, ProviderSpec> },
  io: { secrets: SecretsPort; fetch?: typeof fetch },
): CloudProvider | undefined {
  if (name === "local") return undefined;
  const spec = orch.providers[name];
  if (name === "cursor-cloud") {
    if (!spec) return undefined;
    return cursorProvider({
      secrets: io.secrets,
      keyEnv: spec.keyEnv ?? "CURSOR_API_KEY",
      fetch: io.fetch,
    });
  }
  if (name === "claude-cloud") {
    if (!spec) return undefined;
    return claudeCloudProvider({
      launch: spec.launch ?? [],
      status: spec.status ?? [],
      cancel: spec.cancel ?? [],
    });
  }
  return undefined;
}

export { agentIdFor, cursorProvider } from "./cursor";
export { claudeCloudProvider } from "./claude";
export { cloudLedger } from "./ledger";
export { CloudError, TERMINAL } from "./port";
export type { CloudProvider, CloudRun, CloudStatus, LaunchInput } from "./port";
