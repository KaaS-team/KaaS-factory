// The dashboard package's one entry point: the server factory the core calls (src/dashboard-host.ts).
// Loopback by default and remoteAddress passed through so handle() can enforce it (audit finding #16).
import type { DashboardServerFactory } from "../src/dashboard-host";
import { createDashboard, servingAccess } from "./server";

export const createDashboardServer: DashboardServerFactory = (o) => {
  const app = createDashboard(
    o.state,
    o.github,
    o.repo,
    o.autoApproveDefault,
    undefined,
    o.fleet,
    undefined,
    o.project,
    servingAccess(),
  );
  const server = Bun.serve({
    port: o.port,
    hostname: o.hostname,
    fetch: (req: Request): Promise<Response> => app.handle(req, server.requestIP(req)?.address),
  });
  console.log(`factory dashboard: http://${o.hostname}:${o.port} (repo=${o.repo || "unset"})`);
  app.remote.start();
  return o.port;
};
