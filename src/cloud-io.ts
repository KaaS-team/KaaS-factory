// The real cloud I/O: env secrets, global fetch, wall clock. The engine imports this root so it never names an adapter.

import { EnvSecrets } from "./adapters/env/secrets";
import type { CloudIo } from "./engine/cloud-build";

export function defaultCloudIo(): CloudIo {
  return {
    secrets: new EnvSecrets(),
    fetch: globalThis.fetch.bind(globalThis),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    pollMs: 30_000,
  };
}
