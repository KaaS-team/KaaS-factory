// The environment a guest needs to reach the network only through the egress proxy (src/egress.ts).
// A runtime with an `allow` list starts the proxy for one run, passes these variables, then stops it.

import { type EgressProxy, startEgressProxy } from "./egress";

// Names the allow-list holds: hostnames only, so a stray comma or space cannot widen NO_PROXY.
const HOST = /^[\w.-]+$/;

export const LOOPBACK = "localhost,127.0.0.1,::1";

export function egressEnv(proxyUrl: string, allow: readonly string[]): Record<string, string> {
  const bad = allow.find((h) => !HOST.test(h));
  if (bad !== undefined) throw new Error(`egress: "${bad}" is not a hostname`);
  return {
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    https_proxy: proxyUrl,
    http_proxy: proxyUrl,
    NO_PROXY: LOOPBACK,
    no_proxy: LOOPBACK,
    FACTORY_EGRESS_ALLOW: allow.join(","),
  };
}

// Runs `fn` with the proxy up. `reach` rewrites the proxy's loopback address to what the guest sees
// (a container reaches the host as host.docker.internal).
export async function withEgress<T>(
  allow: readonly string[],
  reach: (loopback: string) => string,
  fn: (env: Record<string, string>) => Promise<T>,
): Promise<T> {
  const proxy: EgressProxy = startEgressProxy({ allow });
  try {
    return await fn(egressEnv(reach(proxy.url), allow));
  } finally {
    proxy.stop();
  }
}
