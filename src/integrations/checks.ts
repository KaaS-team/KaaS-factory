// GitHub Checks API progress: one check run per workflow step on the issue's branch head, in progress
// while the step runs and concluded when it ends, so a PR shows where the factory is. The Checks API
// takes only a GitHub App's installation token, so this reads its own env var, never gh's login.

import type { CloudEvent } from "../core/event";
import { VendorClient, VendorHttpError } from "../adapters/trackers/kit";

export const CHECKS_ENV = { token: "FACTORY_CHECKS_TOKEN" } as const;

const CONCLUSION: Readonly<Record<string, string>> = {
  "factory.step.completed": "success",
  "factory.step.failed": "failure",
};

interface StepData {
  repo?: string;
  issue?: number;
  step?: string;
}

export class CheckProgress {
  private readonly http: VendorClient;
  // issue/step to the check run's id, so the end of a step updates the run its start opened.
  private readonly open = new Map<string, number>();

  constructor(
    url = "https://api.github.com",
    env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.http = new VendorClient(
      "github checks",
      url,
      CHECKS_ENV.token,
      (t) => ({ authorization: `Bearer ${t}` }),
      env,
    );
  }

  // The branch's head, or undefined before the build step has pushed it.
  private async head(repo: string, issue: number): Promise<string | undefined> {
    try {
      return (await this.http.request<{ sha: string }>("GET", `/repos/${repo}/commits/factory%2Fissue-${issue}`)).sha;
    } catch (e) {
      if (e instanceof VendorHttpError && (e.status === 404 || e.status === 422)) return undefined;
      throw e;
    }
  }

  async on(e: CloudEvent): Promise<void> {
    const d = (e.data ?? {}) as StepData;
    if (typeof d.repo !== "string" || typeof d.issue !== "number" || !d.step) return;
    const key = `${d.repo}#${d.issue}/${d.step}`;
    const at = this.now().toISOString();
    if (e.type === "factory.step.started") {
      const sha = await this.head(d.repo, d.issue);
      if (!sha) return;
      const run = await this.http.request<{ id: number }>("POST", `/repos/${d.repo}/check-runs`, {
        body: { name: `factory / ${d.step}`, head_sha: sha, status: "in_progress", started_at: at, external_id: key },
      });
      this.open.set(key, run.id);
      return;
    }
    const conclusion = CONCLUSION[e.type];
    const id = this.open.get(key);
    if (!conclusion || id === undefined) return;
    this.open.delete(key);
    await this.http.request("PATCH", `/repos/${d.repo}/check-runs/${id}`, {
      body: { status: "completed", conclusion, completed_at: at },
    });
  }
}
