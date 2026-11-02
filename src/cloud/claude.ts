import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloudError, type CloudProvider, type CloudRun, type CloudStatus, type LaunchInput } from "./port";

function substitute(
  argv: string[],
  vars: { promptFile?: string; branch?: string; repo?: string; session?: string },
): string[] {
  return argv.map((a) => {
    let s = a;
    if (vars.promptFile !== undefined) s = s.split("{promptFile}").join(vars.promptFile);
    if (vars.branch !== undefined) s = s.split("{branch}").join(vars.branch);
    if (vars.repo !== undefined) s = s.split("{repo}").join(vars.repo);
    if (vars.session !== undefined) s = s.split("{session}").join(vars.session);
    return s;
  });
}

function mapClaudeStatus(raw: string): CloudStatus {
  switch (raw) {
    case "creating":
      return "creating";
    case "running":
      return "running";
    case "finished":
      return "finished";
    case "error":
      return "error";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      return "running";
  }
}

function firstJsonLine(stdout: string): Record<string, unknown> {
  for (const line of stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    return JSON.parse(t) as Record<string, unknown>;
  }
  throw new CloudError("provider", "claude-cloud command did not emit a JSON line");
}

const noLaunch = () => {
  throw new CloudError("provider", "claude-cloud has no launch command configured");
};

export function claudeCloudProvider(opts: {
  launch: string[];
  status: string[];
  cancel: string[];
  run?: (argv: string[]) => Promise<{ code: number; stdout: string }>;
  tmpDir?: string;
}): CloudProvider {
  const run = opts.run ?? (async () => ({ code: 1, stdout: "" }));
  const tmpRoot = opts.tmpDir ?? mkdtempSync(join(tmpdir(), "claude-cloud-"));

  if (opts.launch.length === 0) {
    return {
      name: "claude-cloud",
      launch: noLaunch,
      poll: noLaunch,
      usage: noLaunch,
      steer: noLaunch,
      cancel: noLaunch,
    };
  }

  return {
    name: "claude-cloud",

    async launch(i: LaunchInput): Promise<CloudRun> {
      const dir = opts.tmpDir ?? tmpRoot;
      const promptPath = join(dir, `prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      writeFileSync(promptPath, i.prompt, { mode: 0o600 });
      let stdout = "";
      try {
        const argv = substitute(opts.launch, {
          promptFile: promptPath,
          branch: i.branch,
          repo: i.repoUrl,
        });
        const result = await run(argv);
        stdout = result.stdout;
        if (result.code !== 0) throw new CloudError("provider", "claude-cloud launch failed");
      } finally {
        try {
          rmSync(promptPath, { force: true });
        } catch {
          /* prompt file already gone */
        }
      }
      const json = firstJsonLine(stdout);
      const id = json.id;
      if (typeof id !== "string" || !id) throw new CloudError("provider", "claude-cloud launch missing id");
      return { id, status: "creating" };
    },

    async poll(id: string): Promise<CloudRun> {
      const argv = substitute(opts.status, { session: id });
      const result = await run(argv);
      if (result.code !== 0) throw new CloudError("provider", "claude-cloud status failed");
      const json = firstJsonLine(result.stdout);
      const status = mapClaudeStatus(String(json.status ?? ""));
      const prUrl = typeof json.prUrl === "string" ? json.prUrl : undefined;
      return { id, status, prUrl };
    },

    async usage(_id: string): Promise<{ costUsd?: number }> {
      return {};
    },

    async steer(_id: string, _text: string): Promise<void> {
      throw new CloudError("provider", "steer is not supported by the claude-cloud command");
    },

    async cancel(id: string): Promise<void> {
      const argv = substitute(opts.cancel, { session: id });
      const result = await run(argv);
      if (result.code !== 0) throw new CloudError("provider", "claude-cloud cancel failed");
    },
  };
}
