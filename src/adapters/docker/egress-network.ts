// An allow-listed container joins a private `--internal` network: it has no default route, so the
// only host it can reach is the egress proxy, bound to that network's gateway address. It never
// falls back to `bridge`, so a guest that unsets HTTP(S)_PROXY has nowhere to connect.

import { type EgressProxy, startEgressProxy } from "../../egress";
import { egressEnv } from "../../egress-env";

export const createNetworkArgs = (name: string): string[] => ["docker", "network", "create", "--internal", name];
export const removeNetworkArgs = (name: string): string[] => ["docker", "network", "rm", name];
export const gatewayArgs = (name: string): string[] => [
  "docker",
  "network",
  "inspect",
  "--format",
  "{{(index .IPAM.Config 0).Gateway}}",
  name,
];

async function docker(argv: string[]): Promise<string> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`egress: ${argv.slice(0, 3).join(" ")} failed: ${err.trim()}`);
  return out.trim();
}

// Runs `fn` with an internal network and a proxy on its gateway; both are gone afterwards.
export async function withInternalEgress<T>(
  allow: readonly string[],
  fn: (network: string, env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const name = `factory-egress-${crypto.randomUUID().slice(0, 12)}`;
  await docker(createNetworkArgs(name));
  let proxy: EgressProxy | undefined;
  try {
    const gateway = await docker(gatewayArgs(name));
    proxy = startEgressProxy({ allow, hostname: gateway });
    return await fn(name, egressEnv(proxy.url, allow));
  } finally {
    proxy?.stop();
    await docker(removeNetworkArgs(name)).catch(() => undefined);
  }
}
