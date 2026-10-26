// SPDX-License-Identifier: LicenseRef-KaaS-EE
// A real dashboard with the given ee/ extensions plugged into its plane, and no GitHub behind it.
import { createDashboard } from "../../dashboard/server";
import { createAccess } from "../../dashboard/plane/access";
import type { PlaneExtension } from "../../dashboard/plane/extension";
import { PlaneStore } from "../../dashboard/plane/store";
import { GitHub } from "../../src/github";
import { FactoryState } from "../../src/state";

class QuietGitHub extends GitHub {
  override async listOpenIssues() {
    return [];
  }
  override async listPrs() {
    return [];
  }
  override async getIssue(_repo: string, number: number) {
    return { number, title: "t", body: "", labels: [], comments: [] };
  }
  override async commentIssue() {
    return 1;
  }
  override async addLabels() {}
  override async createIssue() {
    return 7;
  }
}

export const TOKEN = "break-glass-token";

export function plane(
  extensions: PlaneExtension[],
  opts: { env?: Record<string, string>; fetch?: typeof fetch; repo?: string } = {},
) {
  const store = new PlaneStore(":memory:");
  const access = createAccess({ token: TOKEN, store, env: opts.env ?? {}, fetch: opts.fetch, extensions });
  const state = new FactoryState(":memory:");
  const dashboard = createDashboard(
    state,
    new QuietGitHub(),
    opts.repo ?? "acme/widgets",
    false,
    "/nonexistent",
    undefined,
    undefined,
    undefined,
    access,
  );
  const handle = (req: Request, address = "10.0.0.9") => dashboard.handle(req, address);
  return { store, handle, dashboard, state };
}

export const sessionOf = (res: Response) => {
  const c = res.headers.getSetCookie().find((x) => x.startsWith("factory_session="));
  const id = c?.split(";")[0]?.split("=")[1];
  return id ? `factory_session=${id}` : "";
};

// A live session for a login, as if they had just signed in.
export function cookieFor(p: ReturnType<typeof plane>, login: string): string {
  const id = crypto.randomUUID();
  p.store.openSession(id, login, 60_000);
  return `factory_session=${id}`;
}
