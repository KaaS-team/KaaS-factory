// Ported from owainlewis/machinist@3943516 internal/controlplane/web/src/status-loader.js:1-end (MIT, Copyright (c) 2026 Owain Lewis). Deviations: none; verbatim.
export function createStatusLoader({ request, apply }) {
  let latestRequest = 0;

  async function refresh() {
    const requestNumber = ++latestRequest;
    try {
      const status = await request();
      if (requestNumber !== latestRequest) return;
      apply({ kind: "success", status });
    } catch (error) {
      if (requestNumber !== latestRequest) return;
      apply({ kind: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    refresh,
    cancel() {
      latestRequest += 1;
    },
  };
}
