// Which port the dashboard binds. An explicit port is honoured or fails with
// one line; only the default may move to the next free port.

export const DASHBOARD_DEFAULT_PORT = 4100;
const FALLBACK_TRIES = 50;

export function isAddrInUse(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | undefined;
  return e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use|port .* in use/i.test(e?.message ?? "");
}

// `listen(port)` binds and returns the server, or throws. `requested` is the
// operator's port (flag or env); without it, the default and the ports after it are tried.
export function listenOnFreePort<T>(
  requested: number | undefined,
  listen: (port: number) => T,
): { server: T; port: number } {
  if (requested !== undefined) {
    try {
      return { server: listen(requested), port: requested };
    } catch (err) {
      if (isAddrInUse(err)) throw new Error(`dashboard: port ${requested} is already in use`);
      throw err;
    }
  }
  for (let port = DASHBOARD_DEFAULT_PORT; port < DASHBOARD_DEFAULT_PORT + FALLBACK_TRIES; port++) {
    try {
      return { server: listen(port), port };
    } catch (err) {
      if (!isAddrInUse(err)) throw err;
    }
  }
  throw new Error(
    `dashboard: no free port from ${DASHBOARD_DEFAULT_PORT} to ${DASHBOARD_DEFAULT_PORT + FALLBACK_TRIES - 1}`,
  );
}

// Bun.serve on loopback (or `hostname`) through listenOnFreePort. `given` is the raw --port or env value.
export function serveOnFreePort(
  given: string | undefined,
  hostname: string,
  handle: (req: Request, remoteAddress?: string) => Promise<Response>,
): { server: ReturnType<typeof Bun.serve>; port: number } {
  return listenOnFreePort(given === undefined ? undefined : Number(given), (port) => {
    const server: ReturnType<typeof Bun.serve> = Bun.serve({
      port,
      hostname,
      fetch: (req) => handle(req, server.requestIP(req)?.address),
    });
    return server;
  });
}
